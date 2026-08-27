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
  type CompiledUiAsset,
  type CompiledUiCatalog,
  type CompiledUiViewToken,
  type CtxScopeOptions,
  type GateRequest,
  type GateResult,
  isCancellation,
  type Risk,
  StepError,
  type StepRef,
  UI_PROTOCOL_MAX_PROPS_BYTES,
  type Usage,
  validateSchema,
} from "@techery/weft-sdk";
import picomatch from "picomatch";
import type { Budget } from "./budget.ts";
import { canonicalJson, hashStep, sha256Hex } from "./canonical.ts";
import type { ApprovalMode, EngineConfig } from "./config.ts";
import type {
  BlobRefJson,
  HumanKind,
  HumanRequestEvent,
  HumanReviewAttachmentRef,
  HumanReviewFileEdit,
  HumanReviewSubjectRef,
  JournalEvent,
  JournalRecord,
  RunStatus,
  StepKind,
  UiPresentation,
} from "./events.ts";
import { jsonUnsafeAt, unwrapWireValue, wrapWireValue } from "./jsonschema.ts";
import type { Semaphore } from "./limiter.ts";
import type { AgentTaskTrackerHost, ProviderRegistry } from "./provider.ts";
import { type CompletedEntry, OrderedDelivery, type ReplayIndex, type ReuseMode } from "./replay.ts";
import { applyReviewFileEdit } from "./review.ts";
import type { BlobStore, JournalStore } from "./stores.ts";
import { isBlobBeyondRepair } from "./stores.ts";

// `onError: "null"` is allowed to suppress execution failures, but never a
// post-completion settlement failure: the completed output is the durable
// instruction for retrying partially applied side effects. Keep this marker
// process-local so it cannot become part of the public StepError wire format.
const settlementFailures = new WeakSet<StepError>();

export function isSettlementFailure(err: unknown): boolean {
  return err instanceof StepError && settlementFailures.has(err);
}

function markSettlementFailure(err: StepError): StepError {
  settlementFailures.add(err);
  return err;
}

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
  artifactRef?: BlobRefJson;
  reviewSubject?: HumanReviewSubjectRef;
  reviewAttachments?: HumanReviewAttachmentRef[];
  ui?: UiPresentation;
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
  readonly taskTracker?: AgentTaskTrackerHost;
  readonly testHooks?: import("./hooks.ts").TestHooks;
  readonly globalLimiter: Semaphore;
  providerLimiter(id: string): Semaphore;
  clock(): number;
  registerPending(runtime: RunRuntime, request: PendingRequest): void;
  resolvePending(runtime: RunRuntime, id: string): void;
  executeChildRun(spec: ChildRunSpec): Promise<{ output: unknown; usage: Usage; childRunId: string }>;
  onRecords(runtime: RunRuntime, records: JournalRecord[]): void;
}

export interface SharedRunResources {
  budget: Budget;
  abort: AbortController;
  agentCounter: { count: number; warned: boolean };
  reuse: ReuseMode;
  /**
   * False when the workflow script differs from the one that produced the journal being
   * replayed. Step positions carry no meaning across an edit, so a keyless step whose
   * content matches several journaled entries must re-run rather than take the entry
   * that happens to sit at its seq. Defaults to trusted (a fresh run, or a resume of an
   * unchanged script).
   */
  positionsTrusted?: boolean;
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
  /** Canonical identity of this step's kind, payload, schema, and explicit key. */
  hash: string;
  /** Durable journal-record index for this live scheduling occurrence. */
  scheduleIndex: number;
  attempt: number;
  signal: AbortSignal;
  scheduledAt: number;
  /** The ORIGINAL schedule time when resuming an incomplete step (sleep deadlines anchor here). */
  priorScheduledAt?: number;
  childRunId?: string;
  /**
   * True when a journaled COMPLETION for this occurrence was refused by
   * verifyServe: the effect stood once and is being re-established. Recovery
   * shortcuts that tolerate an already-present effect (an existing branch or
   * tag) must key on this — on a first execution the same condition is a
   * COLLISION with someone else's ref and has to surface, not be absorbed.
   */
  reExecuting?: boolean;
  appendAttempt(detail?: string): Promise<void>;
  /** Mark the step as a durable wait (sleep/signal): it stops counting as live work. */
  markWaiting(): void;
  /** Undo markWaiting when the wait ends but the step keeps working (a resumed child). */
  unmarkWaiting(): void;
}

type ExecutionScope = CtxScopeOptions & { phase?: string };

export interface StepOutcome<T> {
  value: T;
  /** JSON journaled as the step output; defaults to `value`. */
  journalOutput?: unknown;
  usage?: Usage;
  sessionId?: string;
  transcriptRef?: BlobRefJson;
  patchRef?: string;
  attempts?: number;
  presentation?: UiPresentation;
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
  /** Caller-supplied replay identity; folded into the hash so two same-worded gates differ. */
  key?: string;
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
  reviewSubject?: HumanReviewSubjectRef;
  reviewAttachments?: HumanReviewAttachmentRef[];
  /** Policy auto-approval: append request+answer in one batch, never wait. */
  auto?: boolean;
  ui?: { view: unknown; props: unknown };
}

export interface HumanOutcome {
  answer: unknown;
  answeredBy: "human" | "policy" | "timeout";
  reviewEdit?: HumanReviewFileEdit;
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
export const MAX_TIMER_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// RunRuntime
// ---------------------------------------------------------------------------

export interface RunRuntimeOptions {
  host: EngineHost;
  runId: string;
  workflowName: string;
  workflowId: string;
  taskSchemaBinding?: string;
  taskSchemaVersion?: number;
  /** Maximum workflow-declared task authority. Agent calls default to read and may only narrow it. */
  agentTaskAccess?: false | "read" | "write";
  cwd: string;
  baseRef?: string;
  depth: number;
  shared: SharedRunResources;
  replay?: ReplayIndex;
  workflowDefaults?: { provider?: string; model?: string; effort?: string };
  uiCatalog?: CompiledUiCatalog;
  /** replay --dry: serve hits, record would-run steps, never execute or append. */
  dry?: boolean;
}

export class RunRuntime {
  readonly host: EngineHost;
  readonly runId: string;
  readonly workflowName: string;
  readonly workflowId: string;
  readonly taskSchemaBinding: string | undefined;
  readonly taskSchemaVersion: number;
  readonly agentTaskAccess: false | "read" | "write";
  readonly cwd: string;
  readonly baseRef: string | undefined;
  readonly depth: number;
  readonly shared: SharedRunResources;
  readonly replay: ReplayIndex | undefined;
  readonly delivery: OrderedDelivery;
  readonly workflowDefaults: { provider?: string; model?: string; effort?: string };
  readonly uiCatalog: CompiledUiCatalog | undefined;
  private readonly uiAssets: Map<string, CompiledUiAsset>;

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
  /**
   * Steps between "matched the journal" and "parked for delivery", i.e. doing replay-path
   * I/O (a blob load, a salvage record). The stall watchdog must not read a turn as quiet
   * while one of these is still on its way to `deliver()`.
   */
  private inflightServing = 0;
  private liveDispatched = false;
  private consumedEntries = 0;
  private appendChain: Promise<unknown> = Promise.resolve();
  private idleListeners: Array<() => void> = [];
  private readonly stepContext = new AsyncLocalStorage<{ seq: number }>();
  private readonly executionScope = new AsyncLocalStorage<ExecutionScope>();

  constructor(opts: RunRuntimeOptions) {
    this.host = opts.host;
    this.runId = opts.runId;
    this.workflowName = opts.workflowName;
    this.workflowId = opts.workflowId;
    this.taskSchemaBinding = opts.taskSchemaBinding;
    this.taskSchemaVersion = opts.taskSchemaVersion ?? 1;
    this.agentTaskAccess = opts.agentTaskAccess ?? false;
    this.cwd = opts.cwd;
    this.baseRef = opts.baseRef;
    this.depth = opts.depth;
    this.shared = opts.shared;
    this.replay = opts.replay;
    this.workflowDefaults = opts.workflowDefaults ?? {};
    this.uiCatalog = opts.uiCatalog;
    this.uiAssets = new Map((opts.uiCatalog?.assets ?? []).map((asset) => [asset.assetKey, asset]));
    this.humanCounter = opts.replay?.maxHumanId ?? 0;
    this.dry = opts.dry ?? false;
    this.dryIndex = (opts.replay?.maxJournalIndex ?? -1) + 1;
    this.delivery = new OrderedDelivery(
      opts.replay?.completionOrders() ?? [],
      () => this.inflightLive + this.inflightServing,
    );
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

  /** Announce a scoped phase without changing the legacy ambient phase pointer. */
  announcePhase(name: string): void {
    if (!this.suppressCosmetic && !this.fencedWith) void this.append([{ type: "phase", name }]);
  }

  activeScope(): ExecutionScope | undefined {
    return this.executionScope.getStore();
  }

  withScope<T>(scope: ExecutionScope, run: () => T): T {
    return this.executionScope.run(scope, run);
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
    // blobThresholdBytes means BYTES on disk: .length counts UTF-16 code units,
    // under which 40k CJK characters (~120KB of UTF-8) would stay inline.
    if (Buffer.byteLength(json) <= this.host.config.limits.blobThresholdBytes) return output ?? null;
    const ref = await this.host.blobs.put(json, { kind: "step-output" });
    return { $outputBlob: ref.hash, size: ref.size, preview: json.slice(0, 200) };
  }

  /**
   * `undefined` when the journaled output lives in a blob that is gone or corrupt — the
   * two conditions re-running the step repairs.
   *
   * A missing blob used to throw, so a run whose only problem was one absent file became
   * permanently unresumable even though the step would simply produce the answer again.
   * But the converse is just as wrong: a store that is merely UNREACHABLE — an
   * object-store timeout, EACCES, EIO — must propagate, because replaying then duplicates
   * the step's side effects and pays for its provider call a second time to recover data
   * that was never lost. Only absence and corruption are a miss; everything else is the
   * storage layer's problem and belongs to the caller.
   */
  async loadOutput(journaled: unknown): Promise<unknown | undefined> {
    if (
      typeof journaled === "object" &&
      journaled !== null &&
      typeof (journaled as { $outputBlob?: unknown }).$outputBlob === "string"
    ) {
      const ref = (journaled as { $outputBlob: string }).$outputBlob;
      let text: string;
      try {
        text = await this.host.blobs.getText(ref);
      } catch (err) {
        if (isBlobBeyondRepair(err)) return undefined;
        throw err;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // Hash-verified bytes that are not JSON: the blob is intact and unusable, which a
        // re-run repairs just as absence does.
        return undefined;
      }
    }
    return journaled;
  }

  /** Resolve an opaque workflow token through the sealed compiler catalog and persist its durable data. */
  async prepareUiPresentation(
    view: unknown,
    props: unknown,
    mode: "display" | "input",
    id: string,
    slot?: string,
  ): Promise<UiPresentation> {
    if (
      typeof view !== "object" ||
      view === null ||
      (view as { kind?: unknown }).kind !== "weft.ui-view" ||
      typeof (view as { assetKey?: unknown }).assetKey !== "string"
    ) {
      throw new StepError("invalid_input", "UI view is not a compiled .ui.tsx token", {
        step: { kind: "ui", runId: this.runId },
      });
    }
    const token = view as CompiledUiViewToken;
    const asset = this.uiAssets.get(token.assetKey);
    if (!asset) {
      throw new StepError(
        "invalid_input",
        `UI asset ${token.assetKey.slice(0, 12)} is not in this workflow build`,
        {
          step: { kind: "ui", runId: this.runId },
        },
      );
    }
    if (asset.mode !== mode) {
      throw new StepError(
        "invalid_input",
        `UI view ${JSON.stringify(asset.id)} is ${asset.mode}, not ${mode}`,
        { step: { kind: "ui", runId: this.runId } },
      );
    }
    const bad = jsonUnsafeAt(props);
    if (bad !== undefined) {
      throw new StepError("invalid_input", `UI props cannot be journaled as JSON at ${bad}`, {
        step: { kind: "ui", runId: this.runId },
      });
    }
    const json = canonicalJson(props);
    const propsBytes = Buffer.byteLength(json);
    if (propsBytes > UI_PROTOCOL_MAX_PROPS_BYTES) {
      throw new StepError(
        "invalid_input",
        `UI props are ${propsBytes} bytes; protocol limit is ${UI_PROTOCOL_MAX_PROPS_BYTES}`,
        { step: { kind: "ui", runId: this.runId } },
      );
    }
    const propsHash = sha256Hex(json);
    const propsJson =
      propsBytes <= this.host.config.limits.blobThresholdBytes
        ? ({ inline: props, hash: propsHash } as const)
        : await this.host.blobs.put(json, { kind: "ui-props", contentType: "application/json" }).then(
            (ref) =>
              ({
                ref: { $blob: ref.hash, size: ref.size, preview: json.slice(0, 200) },
                hash: propsHash,
              }) as const,
          );
    const stored = await this.host.blobs.put(asset.code, {
      kind: "ui-bundle",
      contentType: "text/javascript; charset=utf-8",
    });
    if (stored.hash !== asset.hash) {
      throw new StepError("internal", `compiled UI asset hash mismatch for ${asset.id}`, {
        step: { kind: "ui", runId: this.runId },
      });
    }
    return {
      id,
      asset: {
        id: asset.id,
        revision: asset.revision,
        bundleRef: { $blob: stored.hash, size: stored.size },
        protocol: 1,
      },
      props: propsJson,
      mode,
      ...(slot !== undefined ? { slot } : {}),
    };
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
      // Iterate a COPY: a listener normally unregisters itself as it fires, and
      // `offIdle` splices the live array, which shifts every later element left
      // under the loop's index and skips every second waiter. With two waiters
      // that means one of them never learns the run went idle.
      for (const l of [...this.idleListeners]) l();
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
    // Capture scope synchronously at the call boundary. AsyncLocalStorage keeps
    // concurrent phase handles isolated; phase remains presentation metadata and
    // is deliberately excluded from the replay hash.
    const scheduledPhase = this.activeScope()?.phase ?? this.currentPhase;
    if (this.signal.aborted) {
      throw new CancelledError("run cancelled", { kind: spec.kind, key: spec.key, runId: this.runId });
    }
    if (spec.key !== undefined) {
      if (this.seenKeys.has(spec.key)) {
        throw new StepError(
          "invalid_input",
          `duplicate step key "${spec.key}"; every call in a run must have a unique replay key`,
          { step: { kind: spec.kind, key: spec.key, runId: this.runId } },
        );
      }
      this.seenKeys.add(spec.key);
    }
    const hash = hashStep(spec.kind, spec.payload, spec.schemaJson, spec.key);
    const seq = ++this.seqCounter;
    const ref: StepRef = {
      seq,
      kind: spec.kind,
      runId: this.runId,
      ...(spec.key !== undefined ? { key: spec.key } : {}),
      ...(spec.label !== undefined ? { label: spec.label } : {}),
    };

    // ---- serve from journal ----
    // Everything from here to `deliver()` is replay-path work in flight: counted so the
    // stall watchdog cannot read a turn as quiet while this step is still on its way.
    this.inflightServing++;
    let servingCounted = true;
    const doneServing = (): void => {
      if (servingCounted) {
        servingCounted = false;
        this.inflightServing--;
      }
    };
    let refused: CompletedEntry | undefined;
    try {
      let match = this.replay?.matchStep(
        seq,
        hash,
        spec.kind,
        spec.key,
        // A UI key names the presentation slot; it is not permission to reuse stale
        // props or an older component revision. UI replay is therefore always
        // content-addressed even when the run opts into key-based salvage elsewhere.
        spec.kind === "ui" ? "content" : this.shared.reuse,
        this.shared.positionsTrusted !== false,
      );
      if (match?.ambiguous) {
        // Two keyless call sites share this content: salvaging would guess which one the
        // journaled answer belongs to. Re-run, and say why — `weft replay --dry` surfaces
        // this as a divergence so the cost is visible before a model is called.
        this.log(
          `ambiguous replay identity for ${spec.kind} step #${seq}: more than one journaled ` +
            `step shares this prompt and schema — give each call a distinct \`key\` to reuse them`,
        );
        await this.append([
          {
            type: "replay.diverged",
            seq,
            reason: `ambiguous keyless identity (${spec.kind}): several journaled steps share this content`,
          },
        ]);
        match = undefined;
      }
      if (match && spec.verifyServe) {
        const loaded = await this.loadOutput(match.entry.output);
        if (loaded === undefined || !(await spec.verifyServe(loaded))) {
          refused = match.entry;
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
        const stored = await this.loadOutput(entry.output);
        if (stored === undefined) {
          // The blob this answer lived in is gone or corrupt. Every other unreadable
          // reuse is a cache MISS; this one used to throw, so a run whose only problem
          // was one absent file became permanently unresumable — even though re-running
          // the step would simply produce the answer again.
          this.log(
            `journaled output for ${spec.key ?? spec.kind}#${seq} is unreadable ` +
              `(its blob is missing or corrupt) — re-running the step`,
          );
          await this.append([
            { type: "replay.diverged", seq, reason: `journaled output blob unreadable (${spec.kind})` },
          ]);
        } else {
          entry.consumed = true;
          this.consumedEntries++;
          this.hitCount++;
          if (via !== "seq") {
            this.salvageCount++;
            await this.append([{ type: "replay.salvaged", seq, fromSeq: entry.seq }]);
          }
          doneServing();
          await this.delivery.deliver(entry.order);
          const loaded = structuredClone(stored);
          const value = spec.revive ? await spec.revive(loaded, entry) : (loaded as T);
          try {
            await spec.onSettle?.(value, { served: true, entry });
            if (spec.onSettle && !entry.settled) {
              await this.append([{ type: "step.settled", seq: entry.seq }]);
            }
          } catch (err) {
            const stepError = markSettlementFailure(StepError.from(err, { ...ref, seq: entry.seq }));
            await this.append([
              {
                type: "step.failed",
                seq: entry.seq,
                error: stepError.serialize(),
                attempts: 1,
                phase: "settle",
              },
            ]);
            throw stepError;
          }
          return value;
        }
      }
    } finally {
      doneServing();
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
      // A verify-refused COMPLETED step re-executes under a fresh seq: it must
      // re-enter the SAME child run (whose journal replays it), never spawn a
      // fresh one and re-run everything from scratch. The id comes from the
      // EXACT entry matchStep consumed for this occurrence — a hash-wide
      // lookup would hand every same-hash call the last call's child. The
      // journaled output names the id actually used (collisions regenerate
      // it); the entry's scheduled record is the fallback.
      if (childRunId === undefined && refused !== undefined) {
        const out = refused.output as { childRunId?: unknown } | null | undefined;
        childRunId =
          out && typeof out === "object" && typeof out.childRunId === "string"
            ? out.childRunId
            : refused.childRunId;
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
          ...(scheduledPhase !== undefined ? { phase: scheduledPhase } : {}),
          ...(this.parentSeq() !== undefined ? { parentSeq: this.parentSeq() } : {}),
          ...(spec.route !== undefined ? { route: spec.route } : {}),
          ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
          ...(spec.payload !== undefined ? { payload: spec.payload } : {}),
          ...(spec.schemaJson !== undefined ? { schema: spec.schemaJson } : {}),
          ...(childRunId !== undefined ? { childRunId } : {}),
        },
      ]);
      const scheduledAt = scheduled[0]!.at;
      // A timed wait resumed mid-flight keeps its ORIGINAL deadline: the prior
      // incomplete schedule anchors the clock, so repeated restarts can never
      // stretch a ten-minute timeout indefinitely. (Clamped to 1ms — a zero
      // would read as "no timeout" downstream.)
      const timeoutMs =
        spec.timeoutMs !== undefined && priorScheduledAt !== undefined
          ? Math.max(1, priorScheduledAt + spec.timeoutMs - this.host.clock())
          : spec.timeoutMs;

      const maxAttempts = 1 + (spec.retry?.attempts ?? 0);
      let attempt = 0;
      for (;;) {
        attempt++;
        let completed = false;
        // Per-attempt abort: a step timeout aborts THIS attempt's signal so the
        // provider tears down its session; a retry gets a fresh controller.
        const stepAbort = new AbortController();
        const onRunAbort = () => stepAbort.abort();
        if (this.signal.aborted) stepAbort.abort();
        else this.signal.addEventListener("abort", onRunAbort, { once: true });
        try {
          const io: StepIO = {
            seq,
            hash,
            scheduleIndex: scheduled[0]!.i,
            attempt,
            signal: stepAbort.signal,
            scheduledAt,
            ...(priorScheduledAt !== undefined ? { priorScheduledAt } : {}),
            ...(childRunId !== undefined ? { childRunId } : {}),
            ...(refused !== undefined ? { reExecuting: true } : {}),
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
            this.withTimeout(spec.execute(io), timeoutMs, ref, stepAbort),
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
              ...(outcome.presentation !== undefined ? { presentation: outcome.presentation } : {}),
              attempts: outcome.attempts ?? attempt,
            },
          ]);
          completed = true;
          await spec.onSettle?.(outcome.value, { served: false });
          if (spec.onSettle) await this.append([{ type: "step.settled", seq }]);
          return outcome.value;
        } catch (err) {
          unmarkWaiting();
          const stepError =
            this.signal.aborted && !isCancellation(err)
              ? new CancelledError("run cancelled", ref)
              : StepError.from(err, ref);
          if (completed) markSettlementFailure(stepError);
          // An error BUILT inside execute() carries its own step ref, usually
          // without the seq only this runner knows: enrich it so downstream
          // consumers (drops, durable suppression) can address the step.
          if (stepError.step.seq === undefined) (stepError.step as { seq?: number }).seq = seq;
          const retryable =
            !completed &&
            !isCancellation(stepError) &&
            stepError.code !== "budget_exceeded" &&
            stepError.code !== "gate_denied" &&
            stepError.code !== "human_denied" &&
            attempt < maxAttempts;
          if (!retryable) {
            await this.append([
              {
                type: "step.failed",
                seq,
                error: stepError.serialize(),
                attempts: attempt,
                phase: completed ? "settle" : "execute",
              },
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
          // Armed in CHUNKS like sleep(): Node clamps a timer past 2^31-1ms to
          // ~1ms, which would fail a 30-day step timeout almost immediately.
          // ref'd on purpose: bounded, cleared in finally, and it must be able to
          // fail the step even when a hung provider holds no handles of its own
          const deadline = Date.now() + timeoutMs;
          const arm = () => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              resolve(TIMED_OUT);
              return;
            }
            timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
          };
          arm();
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
    // A provider can settle DURING the drain with money already spent (a billed
    // result, or a cancellation carrying accumulated usage). The timeout error
    // is still what wins — but it must CARRY that spend, because its
    // step.failed / step.attempt record is the only place a later resume can
    // restore the charge from. Past the drain the zombie's spend is memory-only
    // by design (the run has moved on; nothing it does may be observable).
    let lateUsage: Usage | undefined;
    await Promise.race([
      promise.then(
        (outcome) => {
          lateUsage = (outcome as { usage?: Usage } | null | undefined)?.usage;
        },
        (err) => {
          lateUsage = (err as { detail?: { usage?: Usage } } | null)?.detail?.usage;
        },
      ),
      new Promise<void>((resolve) => {
        const drain = setTimeout(resolve, 5_000);
        drain.unref?.();
      }),
    ]);
    throw new StepError("timeout", `step timed out after ${timeoutMs}ms`, {
      step: ref,
      ...(lateUsage !== undefined ? { detail: { usage: lateUsage } } : {}),
    });
  }

  // -- humans ---------------------------------------------------------------

  async runHuman(spec: HumanSpec): Promise<HumanOutcome> {
    const requestedPhase = this.activeScope()?.phase ?? this.currentPhase;
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
    const preparedUi = spec.ui
      ? await this.prepareUiPresentation(spec.ui.view, spec.ui.props, "input", "pending")
      : undefined;
    const payload = {
      kind: spec.kind,
      question: spec.question,
      detail: spec.detail ?? null,
      schema: spec.schemaJson ?? null,
      risk: spec.risk ?? null,
      artifact: spec.artifactRef?.$blob ?? null,
      reviewSubject: spec.reviewSubject ?? null,
      reviewAttachments: spec.reviewAttachments ?? [],
      // Timeout settings change what an UNANSWERED request does, so they are
      // part of its identity: editing "2h" to "2d" (or the policy/default) must
      // surface a fresh request on resume, not silently keep the old absolute
      // deadline and fallback. Spread conditionally so requests without
      // timeouts keep their prior hashes.
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.onTimeout !== undefined ? { onTimeout: spec.onTimeout } : {}),
      ...(spec.timeoutDefault !== undefined ? { timeoutDefault: spec.timeoutDefault } : {}),
      ...(preparedUi !== undefined
        ? {
            ui: {
              id: preparedUi.asset.id,
              revision: preparedUi.asset.revision,
              propsHash: preparedUi.props.hash,
            },
          }
        : {}),
    };
    const hash = hashStep("human", payload, undefined, spec.key);
    const seq = ++this.seqCounter;

    let match = this.replay?.matchHuman(hash, seq, this.shared.positionsTrusted !== false, spec.key);
    if (match?.ambiguous) {
      // Two human call sites share this question and schema, and the script moved, so
      // position cannot say which journaled answer belongs to this one. Re-ask instead
      // of serving a coin flip — an approval nobody gave is the one outcome this system
      // must never produce.
      this.log(
        `ambiguous replay identity for human step #${seq}: more than one journaled request ` +
          `shares this question and schema — re-asking rather than serving one of their answers`,
      );
      await this.append([
        {
          type: "replay.diverged",
          seq,
          reason: "ambiguous keyless identity (human): several journaled requests share this content",
        },
      ]);
      match = undefined;
    }
    const entry = match?.entry;
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
            {
              answer: structuredClone(entry.answer.answer),
              answeredBy: entry.answer.answeredBy,
              ...(entry.answer.reviewEdit !== undefined
                ? { reviewEdit: structuredClone(entry.answer.reviewEdit) }
                : {}),
            },
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
      ...(spec.key !== undefined ? { key: spec.key } : {}),
      kind: spec.kind,
      question: spec.question,
      schema: spec.schemaJson ?? {},
      ...(requestedPhase !== undefined ? { phase: requestedPhase } : {}),
      ...(spec.detail !== undefined ? { detail: spec.detail } : {}),
      ...(spec.artifactRef !== undefined ? { artifactRef: spec.artifactRef } : {}),
      ...(spec.reviewSubject !== undefined ? { reviewSubject: spec.reviewSubject } : {}),
      ...(spec.reviewAttachments !== undefined ? { reviewAttachments: spec.reviewAttachments } : {}),
      ...(spec.risk !== undefined ? { risk: spec.risk } : {}),
      ...(spec.timeoutMs !== undefined ? { deadline: now + spec.timeoutMs } : {}),
      ...(spec.onTimeout !== undefined ? { onTimeout: spec.onTimeout } : {}),
      ...(spec.timeoutDefault !== undefined ? { timeoutDefault: spec.timeoutDefault } : {}),
      ...(spec.confirmToken !== undefined ? { confirmToken: spec.confirmToken } : {}),
      ...(preparedUi !== undefined ? { ui: { ...preparedUi, id } } : {}),
    };

    const superseded = spec.key !== undefined ? this.replay?.pendingHumanByKey(spec.key) : undefined;
    const supersedeEvent: JournalEvent | undefined = superseded
      ? {
          type: "human.superseded",
          id: superseded.id,
          byId: id,
          reason: "request semantics changed at the same durable key",
        }
      : undefined;

    if (spec.auto) {
      const answer = { approved: true };
      this.answeredIds.add(id); // the tailer will echo this append; never buffer it
      await this.append([
        ...(supersedeEvent ? [supersedeEvent] : []),
        request,
        { type: "human.answered", id, answer, answeredBy: "policy" },
      ]);
      return { answer, answeredBy: "policy" };
    }

    await this.append([...(supersedeEvent ? [supersedeEvent] : []), request]);
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
      ...(request.artifactRef !== undefined ? { artifactRef: request.artifactRef } : {}),
      ...(request.reviewSubject !== undefined ? { reviewSubject: request.reviewSubject } : {}),
      ...(request.reviewAttachments !== undefined ? { reviewAttachments: request.reviewAttachments } : {}),
      ...(request.ui !== undefined ? { ui: request.ui } : {}),
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
          this.fireHumanTimeout(request.id);
        } else {
          // ref'd on purpose: a one-shot process whose only pending work is this
          // deadline must stay alive to apply the timeout policy (cleared on answer)
          // Chunked past Node's timer ceiling; applyHumanTimeout re-arms if it
          // fires with time still left on the real deadline.
          wait.timer = setTimeout(() => this.fireHumanTimeout(request.id), Math.min(remaining, MAX_TIMER_MS));
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
    // Provenance first: the sentinel is only the ENGINE's timeout marker when
    // the timeout path produced it — a human whose schema legitimately accepts
    // { $timeout: "deny" } must get their answer back, not a human_timeout.
    if (
      outcome.answeredBy === "timeout" &&
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
    let answer = outcome.answer;
    if (realSchema) {
      const check = await validateSchema(realSchema, unwrapWireValue(outcome.answer, wrapped));
      if (!check.ok) {
        throw new StepError(
          "invalid_answer",
          `answer to ${request.id} failed schema validation: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
          { step: { kind: "human", key: request.id, runId: this.runId } },
        );
      }
      answer = check.value;
    }
    await applyReviewFileEdit(this.cwd, request.reviewSubject, outcome.reviewEdit, this.host.blobs);
    return {
      answer,
      answeredBy: outcome.answeredBy,
      ...(outcome.reviewEdit !== undefined ? { reviewEdit: outcome.reviewEdit } : {}),
    };
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
  resolveAnswer(
    id: string,
    answer: unknown,
    answeredBy: HumanOutcome["answeredBy"],
    reviewEdit?: HumanReviewFileEdit,
  ): boolean {
    const wait = this.pendingWaits.get(id);
    if (!wait) return false;
    this.pendingWaits.delete(id);
    if (wait.timer) clearTimeout(wait.timer);
    this.host.resolvePending(this, id);
    if (this.pendingWaits.size === 0 && this.status === "waiting_for_human") this.setStatus("executing");
    this.answeredIds.add(id);
    wait.resolve({ answer, answeredBy, ...(reviewEdit !== undefined ? { reviewEdit } : {}) });
    return true;
  }

  /**
   * Tailer-fed delivery: resolve the waiting step if it is registered, else buffer the
   * answer until its waiter registers — a resume reads the journal before launching, so
   * an answer appended in between is invisible to the replay index and this delivery is
   * its only path in. Echoes of answers already delivered here are dropped.
   */
  deliverAnswer(
    id: string,
    answer: unknown,
    answeredBy: HumanOutcome["answeredBy"],
    reviewEdit?: HumanReviewFileEdit,
  ): boolean {
    if (this.resolveAnswer(id, answer, answeredBy, reviewEdit)) return true;
    if (this.answeredIds.has(id)) return false;
    this.bufferedAnswers.set(id, { answer, answeredBy, ...(reviewEdit !== undefined ? { reviewEdit } : {}) });
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

  /**
   * The deadline timer's entry point: applyHumanTimeout reads and appends to the
   * journal, and a store failure there must neither become an unhandled rejection
   * (killing a long-lived host) nor silently drop the deadline forever — the
   * request would stay pending with no timer left to apply its policy. Re-arm a
   * short retry while the wait is still open; an answered/settled wait stops it.
   */
  private fireHumanTimeout(id: string): void {
    this.applyHumanTimeout(id).catch((err) => {
      if (!this.pendingWaits.has(id)) return;
      const message = err instanceof Error ? err.message : String(err);
      this.log(`applying the deadline for ${id} failed (${message}); retrying in 5s`);
      const wait = this.pendingWaits.get(id);
      if (wait) wait.timer = setTimeout(() => this.fireHumanTimeout(id), 5_000);
    });
  }

  private async applyHumanTimeout(id: string): Promise<void> {
    if (this.detachedFromHost) return; // the next owner applies deadlines, not us
    const wait = this.pendingWaits.get(id);
    if (!wait) return;
    const { request } = wait;
    // A chunked long deadline fires early by design: re-arm for the remainder.
    const remaining = (request.deadline ?? 0) - this.host.clock();
    if (remaining > 0) {
      wait.timer = setTimeout(() => this.fireHumanTimeout(id), Math.min(remaining, MAX_TIMER_MS));
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
    // The deadline settles under the SAME atomicity contract as Engine.answer():
    // a human submission from another process can land between this timer firing
    // and this append — un-CAS'd, both would journal, both look accepted, and
    // the workflow could proceed with the OPPOSITE of the accepted decision.
    // On losing, the winner's delivery settles the wait; the default never
    // overwrites a real answer.
    const event: JournalEvent = { type: "human.answered", id, answer, answeredBy: "timeout" };
    if (this.host.journal.appendIf) {
      for (;;) {
        if (this.fencedWith || this.detachedFromHost) return;
        let count = 0;
        let standing = false;
        let terminal = false;
        for await (const rec of this.host.journal.read(this.runId)) {
          count++;
          if (rec.ev.type === "human.answered" && rec.ev.id === id) standing = true;
          else if (rec.ev.type === "human.rejected" && rec.ev.id === id) standing = false;
          else if (
            rec.ev.type === "run.completed" ||
            rec.ev.type === "run.failed" ||
            rec.ev.type === "run.cancelled"
          ) {
            terminal = true;
          }
        }
        // A TERMINAL event landed between this deadline firing and its append
        // (an external process's cancel): abandon the timeout answer — same
        // contract as Engine.answer()'s CAS. Appending after run.cancelled
        // would resolveAnswer() into workflow code already past its death.
        if (terminal) return;
        if (standing) return; // a real answer won this request
        if (await this.host.journal.appendIf(this.runId, count, [event])) break;
      }
    } else {
      await this.append([event]);
    }
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

  async gateStep(req: GateRequest): Promise<GateResult> {
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
      ...(req.key !== undefined ? { key: req.key } : {}),
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
