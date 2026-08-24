/**
 * RunRuntime: per-run execution state and the generic step runner. Every side
 * effect flows through runStep(): identity hash → journal match (serve) or live
 * dispatch (execute + append). Humans flow through runHuman() the same way — a
 * human step is an agent step whose provider is a person.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AnySchema,
  CancelledError,
  type GateResult,
  isCancellation,
  type Risk,
  StepError,
  type StepRef,
  type Usage,
  validateSchema,
} from "@weft/sdk";
import picomatch from "picomatch";
import type { Budget } from "./budget.ts";
import { canonicalJson, hashStep, sha256Hex } from "./canonical.ts";
import type { ApprovalMode, EngineConfig } from "./config.ts";
import type {
  BlobRefJson,
  HumanKind,
  HumanRequestEvent,
  JournalEvent,
  JournalRecord,
  RunStatus,
  StepKind,
} from "./events.ts";
import { jsonUnsafeAt, unwrapWireValue, wrapWireValue } from "./jsonschema.ts";
import type { Semaphore } from "./limiter.ts";
import type { ProviderRegistry } from "./provider.ts";
import { type CompletedEntry, OrderedDelivery, type ReplayIndex, type ReuseMode } from "./replay.ts";
import type { BlobStore, JournalStore } from "./stores.ts";

// ---------------------------------------------------------------------------
// Host seam (implemented by Engine)
// ---------------------------------------------------------------------------

export interface PendingRequest {
  runId: string;
  id: string;
  kind: HumanKind;
  question: string;
  detail?: string;
  schema: unknown;
  risk?: Risk;
  createdAt: number;
  deadline?: number;
  confirmToken?: string;
}

export interface ChildRunSpec {
  parent: RunRuntime;
  name: string;
  def?: unknown;
  input: unknown;
  childRunId: string;
  key?: string;
  budget?: { fraction?: number; tokens?: number; usd?: number };
  /**
   * The parent workflow step's wait toggles. While the child is suspended on a
   * person or a signal, the awaiting step is a WAIT, not live work — flipping it
   * lets the parent runtime go idle and surface the child's pending requests
   * through the parent handle.
   */
  waitBridge?: { markWaiting(): void; unmarkWaiting(): void };
}

export interface EngineHost {
  readonly config: EngineConfig;
  readonly providers: ProviderRegistry;
  readonly journal: JournalStore;
  readonly blobs: BlobStore;
  readonly testHooks?: import("./hooks.ts").TestHooks;
  readonly globalLimiter: Semaphore;
  providerLimiter(id: string): Semaphore;
  clock(): number;
  registerPending(runtime: RunRuntime, request: PendingRequest): void;
  resolvePending(runtime: RunRuntime, id: string): void;
  executeChildRun(spec: ChildRunSpec): Promise<{ output: unknown; usage: Usage }>;
  onRecords(runtime: RunRuntime, records: JournalRecord[]): void;
}

export interface SharedRunResources {
  budget: Budget;
  abort: AbortController;
  agentCounter: { count: number; warned: boolean };
  reuse: ReuseMode;
}

export interface PatchState {
  key: string;
  ref: string;
  files: string[];
  quarantined: boolean;
  outOfScope: string[];
  integrated: boolean;
  discarded: boolean;
}

// ---------------------------------------------------------------------------
// Step specs
// ---------------------------------------------------------------------------

export interface StepIO {
  seq: number;
  attempt: number;
  signal: AbortSignal;
  scheduledAt: number;
  /** The ORIGINAL schedule time when resuming an incomplete step (sleep deadlines anchor here). */
  priorScheduledAt?: number;
  childRunId?: string;
  appendAttempt(detail?: string): Promise<void>;
  /** Mark the step as a durable wait (sleep/signal): it stops counting as live work. */
  markWaiting(): void;
  /** Undo markWaiting when the wait ends but the step keeps working (a resumed child). */
  unmarkWaiting(): void;
}

export interface StepOutcome<T> {
  value: T;
  /** JSON journaled as the step output; defaults to `value`. */
  journalOutput?: unknown;
  usage?: Usage;
  sessionId?: string;
  transcriptRef?: BlobRefJson;
  patchRef?: string;
  attempts?: number;
}

export interface StepSpec<T> {
  kind: StepKind;
  key?: string;
  label?: string;
  payload: unknown;
  schemaJson?: unknown;
  retry?: { attempts: number; backoffMs?: number };
  timeoutMs?: number;
  route?: { provider: string; model?: string; effort?: string };
  scope?: { paths: string[]; also?: string[]; mode: "warn" | "strict" };
  /** Reuse a prior incomplete scheduled entry (sub-workflow child ids, sleep deadlines). */
  reuseIncomplete?: boolean;
  newChildRunId?: () => string;
  execute(io: StepIO): Promise<StepOutcome<T>>;
  revive?(journaled: unknown, entry: CompletedEntry): Promise<T> | T;
  /** Return false to reject serving a journaled effect whose result no longer holds. */
  verifyServe?(journaled: unknown): Promise<boolean>;
  onSettle?(value: T, info: { served: boolean; entry?: CompletedEntry }): void | Promise<void>;
}

interface HumanSpec {
  kind: HumanKind;
  question: string;
  detail?: string;
  schemaJson: unknown;
  realSchema?: AnySchema;
  /** True when schemaJson wraps a primitive as { value } — answers unwrap before validation. */
  wrapped?: boolean;
  risk?: Risk;
  timeoutMs?: number;
  onTimeout?: "deny" | "escalate" | "default";
  timeoutDefault?: unknown;
  confirmToken?: string;
  artifactRef?: BlobRefJson;
  /** Policy auto-approval: append request+answer in one batch, never wait. */
  auto?: boolean;
}

export interface HumanOutcome {
  answer: unknown;
  answeredBy: "human" | "policy" | "timeout";
}

interface PendingWait {
  request: HumanRequestEvent;
  realSchema?: AnySchema;
  wrapped: boolean;
  resolve: (outcome: HumanOutcome) => void;
  reject: (err: unknown) => void;
  timer?: NodeJS.Timeout;
}

const TIMEOUT_DENY_MARKER = { $timeout: "deny" } as const;

/** Node's timer ceiling (2^31-1 ms): anything past it clamps to ~1ms unless chunked. */
const MAX_TIMER_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// RunRuntime
// ---------------------------------------------------------------------------

export interface RunRuntimeOptions {
  host: EngineHost;
  runId: string;
  workflowName: string;
  cwd: string;
  baseRef?: string;
  depth: number;
  shared: SharedRunResources;
  replay?: ReplayIndex;
  workflowDefaults?: { provider?: string; model?: string; effort?: string };
  /** replay --dry: serve hits, record would-run steps, never execute or append. */
  dry?: boolean;
}

export class RunRuntime {
  readonly host: EngineHost;
  readonly runId: string;
  readonly workflowName: string;
  readonly cwd: string;
  readonly baseRef: string | undefined;
  readonly depth: number;
  readonly shared: SharedRunResources;
  readonly replay: ReplayIndex | undefined;
  readonly delivery: OrderedDelivery;
  readonly workflowDefaults: { provider?: string; model?: string; effort?: string };

  currentPhase: string | undefined;
  status: RunStatus = "planning";
  readonly patches = new Map<string, PatchState>();
  readonly requiredCheckFailures: string[] = [];
  readonly pendingWaits = new Map<string, PendingWait>();
  /** Tailer-fed answers that arrived before their waiter registered (mirror of bufferedSignals). */
  private readonly bufferedAnswers = new Map<
    string,
    { answer: unknown; answeredBy: HumanOutcome["answeredBy"] }
  >();
  /** Ids whose answer this process already delivered — makes tailer echoes no-ops. */
  private readonly answeredIds = new Set<string>();
  /** Set by detach(): the host is exiting and hands the run to whoever resumes it. */
  private detachedFromHost = false;
  /** Set by fence(): the journal is no longer this process's to write. */
  private fencedWith: StepError | undefined;
  waitingSteps = 0;
  readonly dry: boolean;
  hitCount = 0;
  salvageCount = 0;
  readonly dryDiverged: StepRef[] = [];
  readonly dryPending: string[] = [];

  private dryIndex = 0;
  private seqCounter = 0;
  private readonly seenKeys = new Set<string>();
  private humanCounter = 0;
  private agentOrdinal = 0;
  private inflightLive = 0;
  private liveDispatched = false;
  private consumedEntries = 0;
  private appendChain: Promise<unknown> = Promise.resolve();
  private idleListeners: Array<() => void> = [];
  private readonly stepContext = new AsyncLocalStorage<{ seq: number }>();

  constructor(opts: RunRuntimeOptions) {
    this.host = opts.host;
    this.runId = opts.runId;
    this.workflowName = opts.workflowName;
    this.cwd = opts.cwd;
    this.baseRef = opts.baseRef;
    this.depth = opts.depth;
    this.shared = opts.shared;
    this.replay = opts.replay;
    this.workflowDefaults = opts.workflowDefaults ?? {};
    this.humanCounter = opts.replay?.maxHumanId ?? 0;
    this.dry = opts.dry ?? false;
    this.dryIndex = (opts.replay?.maxJournalIndex ?? -1) + 1;
    this.delivery = new OrderedDelivery(opts.replay?.completionOrders() ?? [], () => this.inflightLive);
  }

  get budget(): Budget {
    return this.shared.budget;
  }

  get signal(): AbortSignal {
    return this.shared.abort.signal;
  }

  /** True while replaying with no live dispatch yet: cosmetic events already exist. */
  private get suppressCosmetic(): boolean {
    return this.replay !== undefined && !this.liveDispatched;
  }

  private get insideHistory(): boolean {
    return this.replay !== undefined && this.consumedEntries < this.replay.entryCount;
  }

  // -- journal --------------------------------------------------------------

  append(events: JournalEvent[]): Promise<JournalRecord[]> {
    if (this.dry) {
      const at = this.host.clock();
      return Promise.resolve(events.map((ev) => ({ i: this.dryIndex++, at, ev })));
    }
    // Fenced: another process may own this journal now — refuse the write so the
    // step awaiting it unwinds instead of interleaving with the new owner.
    if (this.fencedWith) return Promise.reject(this.fencedWith);
    const next = this.appendChain.then(async () => {
      const records = await this.host.journal.append(this.runId, events);
      this.host.onRecords(this, records);
      return records;
    });
    this.appendChain = next.catch(() => undefined);
    return next;
  }

  /** Every append issued before now has hit the store (or failed) once this resolves. */
  flushAppends(): Promise<void> {
    return this.appendChain.then(
      () => undefined,
      () => undefined,
    );
  }

  setStatus(status: RunStatus): void {
    if (this.status === status || this.fencedWith) return;
    this.status = status;
    void this.append([{ type: "run.status", status }]);
  }

  phase(name: string): void {
    if (this.currentPhase === name) return;
    this.currentPhase = name;
    if (!this.suppressCosmetic && !this.fencedWith) void this.append([{ type: "phase", name }]);
  }

  log(message: string): void {
    if (!this.suppressCosmetic && !this.fencedWith) void this.append([{ type: "log", message }]);
  }

  recordDrop(error: StepError): void {
    if (this.suppressCosmetic || this.fencedWith) return;
    void this.append([
      {
        type: "drop",
        ...(error.step.seq !== undefined ? { seq: error.step.seq } : {}),
        ...(error.step.key !== undefined ? { key: error.step.key } : {}),
        reason: `${error.code}: ${error.message}`,
      },
    ]);
  }

  // -- blob offload ---------------------------------------------------------

  async offloadOutput(output: unknown): Promise<unknown> {
    const json = canonicalJson(output ?? null);
    if (json.length <= this.host.config.limits.blobThresholdBytes) return output ?? null;
    const ref = await this.host.blobs.put(json, { kind: "step-output" });
    return { $outputBlob: ref.hash, size: ref.size, preview: json.slice(0, 200) };
  }

  async loadOutput(journaled: unknown): Promise<unknown> {
    if (
      typeof journaled === "object" &&
      journaled !== null &&
      typeof (journaled as { $outputBlob?: unknown }).$outputBlob === "string"
    ) {
      return JSON.parse(await this.host.blobs.getText((journaled as { $outputBlob: string }).$outputBlob));
    }
    return journaled;
  }

  // -- idle / wait tracking -------------------------------------------------

  hasPendingWaits(): boolean {
    return this.pendingWaits.size > 0 || this.waitingSteps > 0;
  }

  /** Steps currently counted as live work (waiting steps excluded). */
  liveStepCount(): number {
    return this.inflightLive;
  }

  onIdle(listener: () => void): void {
    this.idleListeners.push(listener);
    // Level-triggered: a listener registered after the run already suspended
    // must still fire.
    if (this.inflightLive === 0 && this.hasPendingWaits()) queueMicrotask(listener);
  }

  offIdle(listener: () => void): void {
    const idx = this.idleListeners.indexOf(listener);
    if (idx >= 0) this.idleListeners.splice(idx, 1);
  }

  private checkIdle(): void {
    if (this.inflightLive === 0 && this.hasPendingWaits()) {
      const listeners = this.idleListeners;
      for (const l of listeners) l();
    }
  }

  nextAgentOrdinal(): number {
    return ++this.agentOrdinal;
  }

  bumpAgentCount(ref: StepRef): void {
    const counter = this.shared.agentCounter;
    counter.count++;
    const { agentGuideline, agentHard } = this.host.config.limits;
    if (counter.count > agentHard) {
      throw new StepError("internal", `agent step cap exceeded (${agentHard})`, { step: ref });
    }
    if (counter.count > agentGuideline && !counter.warned) {
      counter.warned = true;
      this.log(`agent count passed the guideline of ${agentGuideline} (hard cap ${agentHard})`);
    }
  }

  // -- the step runner ------------------------------------------------------

  parentSeq(): number | undefined {
    return this.stepContext.getStore()?.seq;
  }

  async runStep<T>(spec: StepSpec<T>): Promise<T> {
    if (this.signal.aborted) {
      throw new CancelledError("run cancelled", { kind: spec.kind, key: spec.key, runId: this.runId });
    }
    const hash = hashStep(spec.kind, spec.payload, spec.schemaJson, spec.key);
    const seq = ++this.seqCounter;
    if (spec.key !== undefined) {
      if (this.seenKeys.has(spec.key)) {
        this.log(`duplicate step key "${spec.key}" — give each call a unique key for exact replay identity`);
      }
      this.seenKeys.add(spec.key);
    }
    const ref: StepRef = {
      seq,
      kind: spec.kind,
      runId: this.runId,
      ...(spec.key !== undefined ? { key: spec.key } : {}),
      ...(spec.label !== undefined ? { label: spec.label } : {}),
    };

    // ---- serve from journal ----
    let match = this.replay?.matchStep(seq, hash, spec.kind, spec.key, this.shared.reuse);
    if (match && spec.verifyServe) {
      const loaded = await this.loadOutput(match.entry.output);
      if (!(await spec.verifyServe(loaded))) {
        match.entry.consumed = true;
        this.consumedEntries++;
        await this.append([
          {
            type: "replay.diverged",
            seq,
            reason: `journaled effect for ${spec.key ?? hash.slice(0, 12)} no longer holds`,
          },
        ]);
        match = undefined;
      }
    }
    if (match) {
      const { entry, via } = match;
      entry.consumed = true;
      this.consumedEntries++;
      this.hitCount++;
      if (via !== "seq") {
        this.salvageCount++;
        await this.append([{ type: "replay.salvaged", seq, fromSeq: entry.seq }]);
      }
      await this.delivery.deliver(entry.order);
      const loaded = structuredClone(await this.loadOutput(entry.output));
      const value = spec.revive ? await spec.revive(loaded, entry) : (loaded as T);
      await spec.onSettle?.(value, { served: true, entry });
      return value;
    }

    // ---- live ----
    if (this.dry) {
      this.dryDiverged.push(ref);
      throw new CancelledError(`dry-run: step ${spec.key ?? spec.kind}#${seq} would re-run`, ref);
    }
    if (!this.liveDispatched) {
      this.liveDispatched = true;
      this.delivery.breakOrder();
    }
    if (this.insideHistory) {
      await this.append([
        { type: "replay.diverged", seq, reason: `no journal match for ${spec.key ?? spec.kind}` },
      ]);
    }

    let childRunId: string | undefined;
    let priorScheduledAt: number | undefined;
    if (spec.reuseIncomplete) {
      const prior = this.replay?.matchIncompleteScheduled(hash, spec.kind);
      if (prior) {
        prior.consumed = true;
        childRunId = prior.childRunId;
        priorScheduledAt = prior.at;
      }
      childRunId ??= spec.newChildRunId?.();
    }

    this.inflightLive++;
    let waiting = false;
    const markWaiting = () => {
      if (!waiting) {
        waiting = true;
        this.inflightLive--;
        this.waitingSteps++;
        this.checkIdle();
      }
    };
    const unmarkWaiting = () => {
      if (waiting) {
        waiting = false;
        this.inflightLive++;
        this.waitingSteps--;
      }
    };

    try {
      const scheduled = await this.append([
        {
          type: "step.scheduled",
          seq,
          hash,
          kind: spec.kind,
          ...(spec.key !== undefined ? { key: spec.key } : {}),
          ...(spec.label !== undefined ? { label: spec.label } : {}),
          ...(this.currentPhase !== undefined ? { phase: this.currentPhase } : {}),
          ...(this.parentSeq() !== undefined ? { parentSeq: this.parentSeq() } : {}),
          ...(spec.route !== undefined ? { route: spec.route } : {}),
          ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
          ...(spec.payload !== undefined ? { payload: spec.payload } : {}),
          ...(childRunId !== undefined ? { childRunId } : {}),
        },
      ]);
      const scheduledAt = scheduled[0]!.at;

      const maxAttempts = 1 + (spec.retry?.attempts ?? 0);
      let attempt = 0;
      for (;;) {
        attempt++;
        // Per-attempt abort: a step timeout aborts THIS attempt's signal so the
        // provider tears down its session; a retry gets a fresh controller.
        const stepAbort = new AbortController();
        const onRunAbort = () => stepAbort.abort();
        if (this.signal.aborted) stepAbort.abort();
        else this.signal.addEventListener("abort", onRunAbort, { once: true });
        try {
          const io: StepIO = {
            seq,
            attempt,
            signal: stepAbort.signal,
            scheduledAt,
            ...(priorScheduledAt !== undefined ? { priorScheduledAt } : {}),
            ...(childRunId !== undefined ? { childRunId } : {}),
            appendAttempt: async (detail?: string) => {
              // An ABANDONED attempt (timed out past the drain window, still
              // running as a zombie) must not keep writing to the journal.
              if (stepAbort.signal.aborted) return;
              await this.append([
                { type: "step.attempt", seq, attempt, ...(detail !== undefined ? { detail } : {}) },
              ]);
            },
            markWaiting,
            unmarkWaiting,
          };
          const outcome = await this.stepContext.run({ seq }, () =>
            this.withTimeout(spec.execute(io), spec.timeoutMs, ref, stepAbort),
          );
          unmarkWaiting();
          if (this.signal.aborted) throw new CancelledError("run cancelled", ref);
          const journalOutput = await this.offloadOutput(outcome.journalOutput ?? outcome.value);
          await this.append([
            {
              type: "step.completed",
              seq,
              output: journalOutput,
              ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
              ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
              ...(outcome.transcriptRef !== undefined ? { transcriptRef: outcome.transcriptRef } : {}),
              ...(outcome.patchRef !== undefined ? { patchRef: outcome.patchRef } : {}),
              attempts: outcome.attempts ?? attempt,
            },
          ]);
          await spec.onSettle?.(outcome.value, { served: false });
          return outcome.value;
        } catch (err) {
          unmarkWaiting();
          const stepError =
            this.signal.aborted && !isCancellation(err)
              ? new CancelledError("run cancelled", ref)
              : StepError.from(err, ref);
          const retryable =
            !isCancellation(stepError) &&
            stepError.code !== "budget_exceeded" &&
            stepError.code !== "gate_denied" &&
            stepError.code !== "human_denied" &&
            attempt < maxAttempts;
          if (!retryable) {
            await this.append([
              { type: "step.failed", seq, error: stepError.serialize(), attempts: attempt },
            ]);
            throw stepError;
          }
          const backoff = (spec.retry?.backoffMs ?? 1_000) * attempt;
          // The failed attempt's spend was charged live (the error carries it); the
          // retry record is where it survives for a later resume's budget restore.
          const carried = (stepError.detail as { usage?: Usage } | undefined)?.usage;
          await this.append([
            {
              type: "step.attempt",
              seq,
              attempt: attempt + 1,
              detail: `retry after ${stepError.code}`,
              ...(carried !== undefined ? { usage: carried } : {}),
            },
          ]);
          await sleep(backoff, this.signal);
        } finally {
          this.signal.removeEventListener("abort", onRunAbort);
        }
      }
    } finally {
      if (waiting) this.waitingSteps--;
      else this.inflightLive--;
      this.checkIdle();
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number | undefined,
    ref: StepRef,
    stepAbort?: AbortController,
  ): Promise<T> {
    if (!timeoutMs) return promise;
    // When the timer wins the race, the losing execute() promise rejects later
    // (aborted provider); observe it so Node never sees an unhandled rejection.
    promise.catch(() => undefined);
    const TIMED_OUT = Symbol("step-timeout");
    let timer: NodeJS.Timeout | undefined;
    let winner: T | typeof TIMED_OUT;
    try {
      winner = await Promise.race([
        promise,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
          // ref'd on purpose: bounded, cleared in finally, and it must be able to
          // fail the step even when a hung provider holds no handles of its own
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (winner !== TIMED_OUT) return winner;
    // Timed out: abort the attempt, then DRAIN it (bounded) before the timeout
    // surfaces. Failing the step while its execution still runs would let a retry
    // recreate the worktree under the old attempt's feet, or publish a terminal
    // outcome (and release the run's ownership) while the zombie can still edit
    // files and append usage. The drain resolves how the losing promise settles
    // (usually a cancellation from the abort) — the timeout error, which retries,
    // is always what wins. An execution that ignores its abort signal past the
    // drain window is unstoppable in-process; the bound keeps the run live.
    stepAbort?.abort();
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        const drain = setTimeout(resolve, 5_000);
        drain.unref?.();
      }),
    ]);
    throw new StepError("timeout", `step timed out after ${timeoutMs}ms`, { step: ref });
  }

  // -- humans ---------------------------------------------------------------

  async runHuman(spec: HumanSpec): Promise<HumanOutcome> {
    if (this.signal.aborted) throw new CancelledError("run cancelled", { kind: "human", runId: this.runId });
    if (spec.onTimeout === "default") {
      // The default is journaled RAW with the request and, when the deadline
      // fires, replayed through the schema exactly like a human answer — so it
      // must hold JSON and it must validate NOW. A deadline (live, or armed by
      // a later owner after a resume) is the wrong moment to learn the fallback
      // was never acceptable, and a lossy default would answer differently
      // depending on which process applied it. Checked DIRECTLY — an undefined
      // default would vanish from the journaled request and come back as null
      // at the deadline, so it is unjournalable even where the schema takes it.
      const bad = jsonUnsafeAt(spec.timeoutDefault);
      if (bad !== undefined) {
        throw new StepError("invalid_input", `onTimeout.default cannot be journaled as JSON at ${bad}`, {
          step: { kind: "human", key: spec.question.slice(0, 60), runId: this.runId },
        });
      }
      if (spec.realSchema) {
        const check = await validateSchema(spec.realSchema, spec.timeoutDefault);
        if (!check.ok) {
          throw new StepError(
            "invalid_input",
            `onTimeout.default failed the request schema: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
            { step: { kind: "human", key: spec.question.slice(0, 60), runId: this.runId } },
          );
        }
      }
    }
    const payload = {
      kind: spec.kind,
      question: spec.question,
      detail: spec.detail ?? null,
      schema: spec.schemaJson ?? null,
      risk: spec.risk ?? null,
      artifact: spec.artifactRef?.$blob ?? null,
      // Timeout settings change what an UNANSWERED request does, so they are
      // part of its identity: editing "2h" to "2d" (or the policy/default) must
      // surface a fresh request on resume, not silently keep the old absolute
      // deadline and fallback. Spread conditionally so requests without
      // timeouts keep their prior hashes.
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.onTimeout !== undefined ? { onTimeout: spec.onTimeout } : {}),
      ...(spec.timeoutDefault !== undefined ? { timeoutDefault: spec.timeoutDefault } : {}),
    };
    const hash = hashStep("human", payload);
    const seq = ++this.seqCounter;

    const entry = this.replay?.matchHuman(hash);
    if (entry) {
      entry.consumed = true;
      this.consumedEntries++;
      if (entry.answer) {
        this.hitCount++;
        await this.delivery.deliver(entry.answer.order);
        this.answeredIds.add(entry.id);
        try {
          return await this.settleAnswer(
            entry.request,
            spec.realSchema,
            { answer: structuredClone(entry.answer.answer), answeredBy: entry.answer.answeredBy },
            spec.wrapped ?? false,
          );
        } catch (err) {
          if (!(await this.rejectInvalidAnswer(entry.request, err, entry.answer.answeredBy))) throw err;
          // rejected: fall through — the request re-surfaces and waits for a replacement
        }
      }
      // Unanswered request re-surfaces with the same id — never duplicated.
      if (this.dry) {
        this.dryPending.push(entry.id);
        throw new CancelledError(`dry-run: request ${entry.id} is still waiting for an answer`, {
          kind: "human",
          key: entry.id,
          runId: this.runId,
        });
      }
      return this.awaitAnswer(entry.request, spec.realSchema, spec.wrapped ?? false);
    }

    if (this.dry) {
      this.dryDiverged.push({ kind: "human", key: spec.question.slice(0, 60), runId: this.runId });
      throw new CancelledError(`dry-run: human step would be newly requested`, {
        kind: "human",
        runId: this.runId,
      });
    }
    if (!this.liveDispatched) {
      this.liveDispatched = true;
      this.delivery.breakOrder();
    }

    const id = `h${++this.humanCounter}`;
    const now = this.host.clock();
    const request: HumanRequestEvent = {
      type: "human.requested",
      id,
      seq,
      hash,
      kind: spec.kind,
      question: spec.question,
      schema: spec.schemaJson ?? {},
      ...(spec.detail !== undefined ? { detail: spec.detail } : {}),
      ...(spec.artifactRef !== undefined ? { artifactRef: spec.artifactRef } : {}),
      ...(spec.risk !== undefined ? { risk: spec.risk } : {}),
      ...(spec.timeoutMs !== undefined ? { deadline: now + spec.timeoutMs } : {}),
      ...(spec.onTimeout !== undefined ? { onTimeout: spec.onTimeout } : {}),
      ...(spec.timeoutDefault !== undefined ? { timeoutDefault: spec.timeoutDefault } : {}),
      ...(spec.confirmToken !== undefined ? { confirmToken: spec.confirmToken } : {}),
    };

    if (spec.auto) {
      const answer = { approved: true };
      this.answeredIds.add(id); // the tailer will echo this append; never buffer it
      await this.append([request, { type: "human.answered", id, answer, answeredBy: "policy" }]);
      return { answer, answeredBy: "policy" };
    }

    await this.append([request]);
    return this.awaitAnswer(request, spec.realSchema, spec.wrapped ?? false);
  }

  private async awaitAnswer(
    request: HumanRequestEvent,
    realSchema: AnySchema | undefined,
    wrapped: boolean,
  ): Promise<HumanOutcome> {
    // A step blocked on a human is a durable wait, not live work: without this, a
    // conflict ask inside ctx.integrate (or an in-agent ask) would keep the run
    // from ever reporting idle to its host.
    const inStep = this.parentSeq() !== undefined;
    if (inStep) {
      this.inflightLive--;
      this.waitingSteps++;
    }
    try {
      // Loops on rejection: an answer that fails the authoritative schema re-opens
      // the request instead of failing the run (the journal already says "answered",
      // so failing here would leave a run nobody could ever answer again).
      for (;;) {
        const outcome = await this.nextAnswer(request, realSchema, wrapped);
        try {
          return await this.settleAnswer(request, realSchema, outcome, wrapped);
        } catch (err) {
          if (!(await this.rejectInvalidAnswer(request, err, outcome.answeredBy))) throw err;
        }
      }
    } finally {
      if (inStep) {
        this.inflightLive++;
        this.waitingSteps--;
      }
    }
  }

  /** One answer for the request: a buffered early delivery if the tailer beat the waiter here, else a fresh wait. */
  private nextAnswer(
    request: HumanRequestEvent,
    realSchema: AnySchema | undefined,
    wrapped: boolean,
  ): Promise<HumanOutcome> {
    const buffered = this.bufferedAnswers.get(request.id);
    if (buffered) {
      this.bufferedAnswers.delete(request.id);
      this.answeredIds.add(request.id);
      return Promise.resolve(buffered);
    }
    this.setStatus("waiting_for_human");
    this.host.registerPending(this, {
      runId: this.runId,
      id: request.id,
      kind: request.kind,
      question: request.question,
      schema: request.schema,
      createdAt: this.host.clock(),
      ...(request.detail !== undefined ? { detail: request.detail } : {}),
      ...(request.risk !== undefined ? { risk: request.risk } : {}),
      ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
      ...(request.confirmToken !== undefined ? { confirmToken: request.confirmToken } : {}),
    });
    return new Promise<HumanOutcome>((resolve, reject) => {
      const wait: PendingWait = {
        request,
        resolve,
        reject,
        wrapped,
        ...(realSchema !== undefined ? { realSchema } : {}),
      };
      this.pendingWaits.set(request.id, wait);
      if (request.deadline !== undefined) {
        const remaining = request.deadline - this.host.clock();
        if (remaining <= 0) {
          void this.applyHumanTimeout(request.id);
        } else {
          // ref'd on purpose: a one-shot process whose only pending work is this
          // deadline must stay alive to apply the timeout policy (cleared on answer)
          // Chunked past Node's timer ceiling; applyHumanTimeout re-arms if it
          // fires with time still left on the real deadline.
          wait.timer = setTimeout(
            () => void this.applyHumanTimeout(request.id),
            Math.min(remaining, MAX_TIMER_MS),
          );
        }
      }
      queueMicrotask(() => this.checkIdle());
    });
  }

  /**
   * A journaled answer failed the step's authoritative schema. Only a human's answer
   * appended by a process without the real schema can get here (owner-validated and
   * policy/timeout answers are checked before they are journaled): reject it on the
   * record so the request re-opens and a replacement can be appended.
   */
  private async rejectInvalidAnswer(
    request: HumanRequestEvent,
    err: unknown,
    answeredBy: HumanOutcome["answeredBy"],
  ): Promise<boolean> {
    if (!(err instanceof StepError) || err.code !== "invalid_answer" || answeredBy !== "human") return false;
    this.answeredIds.delete(request.id);
    await this.append([{ type: "human.rejected", id: request.id, reason: err.message }]);
    this.log(`rejected the answer to ${request.id} (failed the step's schema); waiting for a replacement`);
    return true;
  }

  private async settleAnswer(
    request: HumanRequestEvent,
    realSchema: AnySchema | undefined,
    outcome: HumanOutcome,
    wrapped: boolean,
  ): Promise<HumanOutcome> {
    if (
      typeof outcome.answer === "object" &&
      outcome.answer !== null &&
      (outcome.answer as { $timeout?: unknown }).$timeout === "deny"
    ) {
      if (request.kind === "ask" || request.kind === "review") {
        throw new StepError("human_timeout", `request ${request.id} timed out (policy: deny)`, {
          step: { kind: "human", key: request.id, runId: this.runId },
        });
      }
      return { answer: { approved: false, note: "timed out" }, answeredBy: "timeout" };
    }
    if (realSchema) {
      const check = await validateSchema(realSchema, unwrapWireValue(outcome.answer, wrapped));
      if (!check.ok) {
        throw new StepError(
          "invalid_answer",
          `answer to ${request.id} failed schema validation: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
          { step: { kind: "human", key: request.id, runId: this.runId } },
        );
      }
      return { answer: check.value, answeredBy: outcome.answeredBy };
    }
    return outcome;
  }

  /**
   * Stop this runtime's local human-deadline timers WITHOUT journaling anything: the
   * host is detaching (process exit) and the run's next owner re-arms deadlines from
   * the journal. Without this, a closed CLI stays alive until the deadline and its
   * timer could append a timeout answer to a run someone else now owns.
   */
  detach(): void {
    this.detachedFromHost = true;
    for (const wait of this.pendingWaits.values()) {
      if (wait.timer) {
        clearTimeout(wait.timer);
        wait.timer = undefined;
      }
    }
  }

  get fenced(): StepError | undefined {
    return this.fencedWith;
  }

  /**
   * This process no longer owns the run's journal (the lease was lost to another
   * process, or the host is shutting down mid-execution). Stop EVERYTHING without
   * journaling a terminal event — the run must stay resumable for its next owner:
   * refuse further appends, disarm deadline timers, reject pending waits, and
   * abort in-flight step work so the workflow unwinds and result settles.
   */
  fence(err: StepError): void {
    if (this.fencedWith) return;
    this.fencedWith = err;
    this.detachedFromHost = true;
    for (const [id, wait] of [...this.pendingWaits]) {
      this.pendingWaits.delete(id);
      if (wait.timer) clearTimeout(wait.timer);
      this.host.resolvePending(this, id);
      wait.reject(err);
    }
    // Signal waiters and live steps listen on the shared signal; children share it
    // too, and unwind with the parent (their journals stay just as resumable).
    if (!this.signal.aborted) this.shared.abort.abort(err);
  }

  /** Deliver an answer to an in-process waiting step; the caller already appended the event. */
  resolveAnswer(id: string, answer: unknown, answeredBy: HumanOutcome["answeredBy"]): boolean {
    const wait = this.pendingWaits.get(id);
    if (!wait) return false;
    this.pendingWaits.delete(id);
    if (wait.timer) clearTimeout(wait.timer);
    this.host.resolvePending(this, id);
    if (this.pendingWaits.size === 0 && this.status === "waiting_for_human") this.setStatus("executing");
    this.answeredIds.add(id);
    wait.resolve({ answer, answeredBy });
    return true;
  }

  /**
   * Tailer-fed delivery: resolve the waiting step if it is registered, else buffer the
   * answer until its waiter registers — a resume reads the journal before launching, so
   * an answer appended in between is invisible to the replay index and this delivery is
   * its only path in. Echoes of answers already delivered here are dropped.
   */
  deliverAnswer(id: string, answer: unknown, answeredBy: HumanOutcome["answeredBy"]): boolean {
    if (this.resolveAnswer(id, answer, answeredBy)) return true;
    if (this.answeredIds.has(id)) return false;
    this.bufferedAnswers.set(id, { answer, answeredBy });
    return false;
  }

  pendingWait(
    id: string,
  ): { request: HumanRequestEvent; realSchema?: AnySchema; wrapped: boolean } | undefined {
    const wait = this.pendingWaits.get(id);
    if (!wait) return undefined;
    return {
      request: wait.request,
      wrapped: wait.wrapped,
      ...(wait.realSchema !== undefined ? { realSchema: wait.realSchema } : {}),
    };
  }

  private async applyHumanTimeout(id: string): Promise<void> {
    if (this.detachedFromHost) return; // the next owner applies deadlines, not us
    const wait = this.pendingWaits.get(id);
    if (!wait) return;
    const { request } = wait;
    // A chunked long deadline fires early by design: re-arm for the remainder.
    const remaining = (request.deadline ?? 0) - this.host.clock();
    if (remaining > 0) {
      wait.timer = setTimeout(() => void this.applyHumanTimeout(id), Math.min(remaining, MAX_TIMER_MS));
      return;
    }
    const policy = request.onTimeout ?? "deny";
    if (policy === "escalate") {
      this.log(`request ${id} passed its deadline; escalated (still waiting)`);
      return;
    }
    // The user-supplied default is unwrapped; wrap it so the journaled answer has
    // the same shape a human answer would (settleAnswer unwraps uniformly).
    const answer =
      policy === "default"
        ? wrapWireValue(request.timeoutDefault ?? null, wait.wrapped)
        : TIMEOUT_DENY_MARKER;
    await this.append([{ type: "human.answered", id, answer, answeredBy: "timeout" }]);
    this.resolveAnswer(id, answer, "timeout");
  }

  // -- gates ----------------------------------------------------------------

  resolveApproval(action: string, risk: Risk): { mode: ApprovalMode; confirm: boolean } {
    const policy = this.host.config.approvalPolicy;
    for (const [pattern, mode] of Object.entries(policy.actions ?? {})) {
      if (picomatch.isMatch(action, pattern))
        return { mode, confirm: risk === "irreversible" && mode === "ask" };
    }
    const tier = policy.tiers?.[risk];
    if (tier) return { mode: tier, confirm: risk === "irreversible" && tier === "ask" };
    if (risk === "low") return { mode: "auto", confirm: false };
    return { mode: "ask", confirm: risk === "irreversible" };
  }

  async gateStep(req: { action: string; risk: Risk; detail?: string }): Promise<GateResult> {
    const { mode, confirm } = this.resolveApproval(req.action, req.risk);
    const confirmToken = confirm ? `confirm:${sha256Hex(req.action).slice(0, 8)}` : undefined;
    const schemaJson = confirm
      ? {
          type: "object",
          properties: {
            approved: { type: "boolean" },
            confirm: { type: "string", description: `type exactly: ${confirmToken}` },
            note: { type: "string" },
          },
          required: ["approved", "confirm"],
        }
      : {
          type: "object",
          properties: { approved: { type: "boolean" }, note: { type: "string" } },
          required: ["approved"],
        };
    const outcome = await this.runHuman({
      kind: confirm ? "confirm" : "gate",
      question: req.action,
      schemaJson,
      risk: req.risk,
      ...(req.detail !== undefined ? { detail: req.detail } : {}),
      ...(confirmToken !== undefined ? { confirmToken } : {}),
      auto: mode === "auto",
    });
    const raw = outcome.answer as { approved?: boolean; note?: string; confirm?: string } | null;
    let approved = raw?.approved === true;
    if (approved && confirm && raw?.confirm !== confirmToken) {
      approved = false;
      this.log(`confirmation token mismatch for "${req.action}" — treating as denied`);
    }
    return {
      approved,
      ...(raw?.note !== undefined ? { note: raw.note } : {}),
      answeredBy: outcome.answeredBy,
    };
  }

  // -- signals --------------------------------------------------------------

  private signalWaiters = new Map<string, Array<{ fire: (payload: unknown) => void; dispose: () => void }>>();
  /** Signals delivered while the run was busy in earlier steps, before a waiter registered. */
  private bufferedSignals = new Map<string, unknown[]>();

  takeOrAwaitSignal(name: string, io: StepIO): Promise<unknown> {
    const journaled = this.replay?.takeSignal(name);
    if (journaled) return Promise.resolve(structuredClone(journaled.payload));
    const buffered = this.bufferedSignals.get(name);
    if (buffered && buffered.length > 0) {
      const payload = buffered.shift();
      if (buffered.length === 0) this.bufferedSignals.delete(name);
      return Promise.resolve(structuredClone(payload));
    }
    io.markWaiting();
    this.setStatus("waiting_for_signal");
    return new Promise<unknown>((resolve, reject) => {
      const waiter = {
        fire: (payload: unknown) => {
          io.signal.removeEventListener("abort", onAbort);
          resolve(payload);
        },
        dispose: () => io.signal.removeEventListener("abort", onAbort),
      };
      const onAbort = () => {
        const list = this.signalWaiters.get(name);
        const idx = list?.indexOf(waiter) ?? -1;
        if (list && idx >= 0) list.splice(idx, 1);
        reject(
          new CancelledError(`run cancelled while waiting for signal "${name}"`, {
            kind: "signal",
            key: name,
            runId: this.runId,
          }),
        );
      };
      if (io.signal.aborted) {
        reject(new CancelledError(`run cancelled while waiting for signal "${name}"`));
        return;
      }
      io.signal.addEventListener("abort", onAbort, { once: true });
      const list = this.signalWaiters.get(name) ?? [];
      list.push(waiter);
      this.signalWaiters.set(name, list);
      queueMicrotask(() => this.checkIdle());
    });
  }

  /** The caller already appended signal.received. */
  deliverSignal(name: string, payload: unknown): boolean {
    const list = this.signalWaiters.get(name);
    const next = list?.shift();
    if (!next) {
      // No waiter yet (the run is busy in earlier steps): buffer for the wait that
      // arrives later — the launch-time replay index cannot see this record.
      const buffered = this.bufferedSignals.get(name) ?? [];
      buffered.push(payload);
      this.bufferedSignals.set(name, buffered);
      return false;
    }
    if (list && list.length === 0) this.signalWaiters.delete(name);
    if (this.signalWaiters.size === 0 && this.status === "waiting_for_signal") this.setStatus("executing");
    next.fire(payload);
    return true;
  }

  /** A run.cancelled appended by ANOTHER process (CLI cancelling a daemon-owned run). */
  externalCancel(): void {
    if (!this.signal.aborted) this.shared.abort.abort(new CancelledError());
    this.cancelHumanWaits();
  }

  /** Cancellation: reject every pending human wait so the run winds down as cancelled. */
  cancelHumanWaits(): void {
    for (const [id, wait] of [...this.pendingWaits]) {
      this.pendingWaits.delete(id);
      if (wait.timer) clearTimeout(wait.timer);
      this.host.resolvePending(this, id);
      wait.reject(
        new CancelledError(`run cancelled while waiting on ${id}`, {
          kind: "human",
          key: id,
          runId: this.runId,
        }),
      );
    }
  }

  hasSignalWaiter(name: string): boolean {
    return (this.signalWaiters.get(name)?.length ?? 0) > 0;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const deadline = Date.now() + ms;
    // ref'd on purpose: a durable ctx.sleep must keep a one-shot process alive
    // until its deadline (aborting clears it). Armed in CHUNKS: Node clamps a
    // timer past 2^31-1ms to ~1ms, which would fire a 30-day sleep immediately.
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new CancelledError());
    };
    const arm = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        signal?.removeEventListener("abort", onAbort);
        resolve();
        return;
      }
      timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    arm();
  });
}
