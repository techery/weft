/**
 * The Engine: starts, resumes, answers, signals, cancels runs. It implements the
 * EngineHost seam RunRuntime executes against, and owns nothing a host needs to
 * be — CLI, MCP server, and daemon are thin shells over this class (C10).
 */
import { randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import {
  CancelledError,
  isCancellation,
  isWorkflowDefinition,
  StepError,
  validateSchema,
  type WorkflowDefinition,
} from "@weft/sdk";
import { Budget } from "./budget.ts";
import { type EngineConfig, type EngineConfigInput, resolveConfig } from "./config.ts";
import { buildCtx } from "./ctx.ts";
import type { JournalEvent, JournalRecord } from "./events.ts";
import { jsonUnsafeAt, structuralCheck } from "./jsonschema.ts";
import { Semaphore } from "./limiter.ts";
import { type RunState, reduceState, renderReport, renderTree } from "./projections.ts";
import type { AgentProvider, ProviderRegistry } from "./provider.ts";
import { ReplayIndex, type ReuseMode } from "./replay.ts";
import {
  type ChildRunSpec,
  type EngineHost,
  type PendingRequest,
  RunRuntime,
  type SharedRunResources,
} from "./runtime.ts";
import type { BlobStore, JournalStore, RunLease, RunListFilter, RunSummary } from "./stores.ts";

const tracer = trace.getTracer("weft");

export interface WorkflowRegistry {
  get(name: string): Promise<WorkflowDefinition | undefined>;
}

export interface EngineOptions {
  journal: JournalStore;
  blobs: BlobStore;
  providers: ProviderRegistry;
  config?: EngineConfigInput;
  registry?: WorkflowRegistry;
  clock?: () => number;
  /** Test seams for @weft/testing fixtures; never set in production hosts. */
  testHooks?: import("./hooks.ts").TestHooks;
}

export interface StartOptions {
  input: unknown;
  cwd: string;
  runId?: string;
  baseRef?: string;
  defHash?: string;
  budget?: { tokens?: number; usd?: number };
  reuse?: ReuseMode;
}

export interface ResumeOptions {
  def?: WorkflowDefinition;
  reuse?: ReuseMode;
}

export type RunOutcome =
  | { status: "complete"; output: unknown }
  | { status: "failed"; error: StepError }
  | { status: "cancelled" }
  | { status: "waiting_for_human" | "waiting_for_signal"; pending: PendingRequest[] };

export interface RunHandle {
  runId: string;
  /** Resolves with the validated output at terminal completion; rejects on failure/cancel. */
  result: Promise<unknown>;
  /** Resolves at terminal state OR when the run suspends on humans/signals/timers. */
  outcome(): Promise<RunOutcome>;
}

interface ActiveRun {
  runtime: RunRuntime;
  def: WorkflowDefinition;
  records: JournalRecord[];
  /** Indices already in records[] — dedupes the tailer against in-process appends. */
  seen: Set<number>;
  result: Promise<unknown>;
  pending: Map<string, PendingRequest>;
  sinceSnapshot: number;
  /** Stops the external-event tailer when the run reaches a terminal state. */
  tail?: AbortController;
  /** Cross-process ownership claim (stores that support one); released at terminal state. */
  lease?: RunLease;
  leaseTimer?: NodeJS.Timeout;
  /**
   * Records present when this execution launched. A run.cancelled BEFORE this
   * boundary is history a resume legitimately re-executes past; one at or after
   * it is a standing order this execution's terminal must yield to.
   */
  seedCount: number;
  /** Serializes projection publication so an older reduction never overwrites a newer one. */
  snapshotChain: Promise<unknown>;
}

export class Engine implements EngineHost {
  readonly config: EngineConfig;
  readonly providers: ProviderRegistry;
  readonly journal: JournalStore;
  readonly blobs: BlobStore;
  readonly testHooks?: import("./hooks.ts").TestHooks;
  readonly globalLimiter: Semaphore;
  private readonly providerLimiters = new Map<string, Semaphore>();
  private readonly registry: WorkflowRegistry | undefined;
  private readonly active = new Map<string, ActiveRun>();
  private readonly clockFn: () => number;

  constructor(opts: EngineOptions) {
    this.journal = opts.journal;
    this.blobs = opts.blobs;
    this.providers = opts.providers;
    this.config = resolveConfig(opts.config);
    this.registry = opts.registry;
    this.clockFn = opts.clock ?? Date.now;
    if (opts.testHooks) this.testHooks = opts.testHooks;
    this.globalLimiter = new Semaphore(this.config.limits.concurrency);
  }

  clock(): number {
    return this.clockFn();
  }

  providerLimiter(id: string): Semaphore {
    let limiter = this.providerLimiters.get(id);
    if (!limiter) {
      limiter = new Semaphore(this.config.providers[id]?.concurrency ?? this.config.limits.concurrency);
      this.providerLimiters.set(id, limiter);
    }
    return limiter;
  }

  // -- lifecycle ------------------------------------------------------------

  async start(def: WorkflowDefinition, opts: StartOptions): Promise<RunHandle> {
    if (!isWorkflowDefinition(def)) throw new TypeError("start: not a workflow definition");
    const runId = opts.runId ?? randomUUID().slice(0, 8);
    if (await this.journal.exists(runId)) {
      throw new Error(`run ${runId} already exists — use resume()`);
    }
    const name = def.meta.name ?? "workflow";
    // The RAW input is what gets journaled, so it must survive the JSONL round
    // trip; the schema is reapplied to it on every execution (below and on each
    // resume), so a transform's output — a Date, a class — never needs to.
    // Only an OMITTED input defaults to {}: an explicit null is a valid value
    // for schemas that accept it, and must round-trip as itself.
    const rawInput = opts.input === undefined ? {} : opts.input;
    const rawInputBad = jsonUnsafeAt(rawInput);
    if (rawInputBad !== undefined) {
      throw new StepError(
        "invalid_input",
        `input cannot be journaled as JSON at ${rawInputBad} — inputs are journaled raw and re-validated on resume`,
        { step: { kind: "workflow", runId } },
      );
    }
    const inputCheck = await validateSchema(def.meta.input, rawInput);
    if (!inputCheck.ok) {
      throw new StepError(
        "invalid_input",
        `input failed ${name}'s input schema: ${inputCheck.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        { step: { kind: "workflow", runId } },
      );
    }
    const shared: SharedRunResources = {
      budget: new Budget(opts.budget ?? {}),
      abort: new AbortController(),
      agentCounter: { count: 0, warned: false },
      reuse: opts.reuse ?? "content",
    };
    const runtime = new RunRuntime({
      host: this,
      runId,
      workflowName: name,
      cwd: opts.cwd,
      depth: 0,
      shared,
      ...(opts.baseRef !== undefined ? { baseRef: opts.baseRef } : {}),
      ...(def.meta.defaults !== undefined ? { workflowDefaults: def.meta.defaults } : {}),
    });
    const lease = await this.claimRun(runId);
    // The appended records flow into launch as the projection seed: the run is not
    // in the active map yet, so onRecords would otherwise drop run.created and the
    // first snapshots (and list filters) would miss the run's identity.
    let created: JournalRecord[];
    try {
      created = await runtime.append([
        {
          type: "run.created",
          runId,
          workflow: { name, ...(opts.defHash !== undefined ? { defHash: opts.defHash } : {}) },
          // Raw, not inputCheck.value: a transformed value (string → Date) would
          // serialize lossily and hand a resumed execution a different input type.
          input: rawInput,
          cwd: opts.cwd,
          depth: 0,
          ...(opts.baseRef !== undefined ? { baseRef: opts.baseRef } : {}),
          ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
        },
      ]);
    } catch (err) {
      // The claim must not outlive a run that never began: a filesystem claim
      // would block retries of this id until its TTL, a non-expiring store's forever.
      await lease?.release().catch(() => undefined);
      throw err;
    }
    return this.launch(runtime, def, inputCheck.value, created, lease);
  }

  async resume(runId: string, opts: ResumeOptions = {}): Promise<RunHandle> {
    const existing = this.active.get(runId);
    if (existing) {
      return {
        runId,
        result: existing.result,
        outcome: () => this.outcomeOf(existing),
      };
    }
    const records: JournalRecord[] = [];
    for await (const rec of this.journal.read(runId)) records.push(rec);
    if (records.length === 0) throw new Error(`run ${runId} not found`);
    const created = records.find((r) => r.ev.type === "run.created")?.ev;
    if (created?.type !== "run.created") throw new Error(`run ${runId}: missing run.created`);

    let def = opts.def;
    if (!def && this.registry) def = await this.registry.get(created.workflow.name);
    if (!def) {
      throw new Error(
        `run ${runId}: no definition for "${created.workflow.name}" (pass def or configure a registry)`,
      );
    }

    // The journal holds the RAW input; reapply the schema so a transform hands the
    // resumed execution the same shape (a Date, a default) the first one saw.
    const inputCheck = await validateSchema(def.meta.input, created.input === undefined ? {} : created.input);
    if (!inputCheck.ok) {
      throw new StepError(
        "invalid_input",
        `input failed ${created.workflow.name}'s input schema on resume: ${inputCheck.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        { step: { kind: "workflow", runId } },
      );
    }

    // The claim comes before the runtime exists: waking a run a daemon or CLI is
    // still executing would run it twice.
    const lease = await this.claimRun(runId);
    try {
      return this.resumeSetup(runId, records, created, def, opts, inputCheck.value, lease);
    } catch (err) {
      // Setup failed before drive() (whose finally owns the release from launch
      // on): the claim must not outlive an execution that never started.
      await lease?.release().catch(() => undefined);
      throw err;
    }
  }

  /** The claimed half of resume(); everything here throws to a lease-releasing catch. */
  private resumeSetup(
    runId: string,
    records: JournalRecord[],
    created: Extract<JournalEvent, { type: "run.created" }>,
    def: WorkflowDefinition,
    opts: ResumeOptions,
    input: unknown,
    lease: RunLease | undefined,
  ): RunHandle {
    const replay = ReplayIndex.fromRecords(records);
    const shared: SharedRunResources = {
      // The journaled ceiling survives resume; spend restores from journaled usage.
      budget: new Budget(created.budget ?? {}),
      abort: new AbortController(),
      agentCounter: { count: 0, warned: false },
      reuse: opts.reuse ?? "content",
    };
    shared.budget.restore(replay.totalUsage.tokens, replay.totalUsage.usd, replay.totalUsage.samples);
    const runtime = new RunRuntime({
      host: this,
      runId,
      workflowName: created.workflow.name,
      cwd: created.cwd,
      depth: created.depth,
      shared,
      replay,
      ...(created.baseRef !== undefined ? { baseRef: created.baseRef } : {}),
      ...(def.meta.defaults !== undefined ? { workflowDefaults: def.meta.defaults } : {}),
    });
    return this.launch(runtime, def, input, records, lease);
  }

  /** Claim a run before executing it; throws when another live process owns it. */
  private async claimRun(runId: string): Promise<RunLease | undefined> {
    if (!this.journal.acquireRun) return undefined;
    const lease = await this.journal.acquireRun(runId);
    if (!lease) throw new Error(`run ${runId} is active in another process`);
    return lease;
  }

  private launch(
    runtime: RunRuntime,
    def: WorkflowDefinition,
    input: unknown,
    priorRecords: JournalRecord[] = [],
    lease?: RunLease,
  ): RunHandle {
    const active: ActiveRun = {
      runtime,
      def,
      records: [...priorRecords],
      seen: new Set(priorRecords.map((r) => r.i)),
      seedCount: priorRecords.length,
      pending: new Map(),
      sinceSnapshot: 0,
      result: undefined as never,
      snapshotChain: Promise.resolve(),
      ...(lease ? { lease } : {}),
    };
    this.active.set(runtime.runId, active);
    if (lease) {
      // unref'd: the claim guards a run whose own work keeps the process alive.
      // A refresh that reports the claim LOST (this process stalled past the TTL
      // and another took over) must stop this runtime, not merely stop renewing:
      // the new owner is executing the same run against the same journal.
      active.leaseTimer = setInterval(
        () =>
          void lease
            .refresh()
            .then((held) => {
              if (held === false) this.fenceLostRun(active);
            })
            .catch(() => undefined),
        5_000,
      );
      active.leaseTimer.unref?.();
    }
    // The owning engine consumes events other processes append to this run's journal
    // (answers, signals, cancellation) — without this, a CLI answering or cancelling
    // a daemon-owned run would append events nobody ever delivers.
    active.tail = new AbortController();
    void this.tailExternalEvents(active, priorRecords.length, active.tail.signal);
    active.result = this.drive(active, def, input);
    // Observed via handle/outcome — avoid unhandledRejection; chain the cleanup off
    // the caught promise so the .finally() derivative can never reject unobserved.
    // Entries persist while suspended; at terminal state a later resume() must
    // replay instead of returning the settled promise, and records[] is freed.
    void active.result
      .catch(() => undefined)
      .finally(() => {
        active.tail?.abort();
        if (this.active.get(runtime.runId) === active) this.active.delete(runtime.runId);
      });
    return {
      runId: runtime.runId,
      result: active.result,
      outcome: () => this.outcomeOf(active),
    };
  }

  /**
   * Land a terminal event CONDITIONALLY. Another process can commit run.cancelled
   * (through the cancel CAS) while this owner's journal tailer — a 400ms poll on
   * filesystem stores — has not seen it yet; an unconditional run.completed or
   * run.failed would then land AFTER it and override a committed cancellation in
   * every projection. The record count is checked under the store's append lock;
   * a lost race re-reads — a cancellation found there converts the outcome
   * (returns false), anything else (a late answer or signal) retries with the
   * new count. A run.cancelled of our own is deduped against an external one.
   */
  private async appendTerminal(active: ActiveRun, events: JournalEvent[]): Promise<boolean> {
    const rt = active.runtime;
    if (rt.fenced) throw rt.fenced;
    if (!this.journal.appendIf) {
      await rt.append(events);
      return true;
    }
    // Everything this runtime already issued must be on disk before counting.
    await rt.flushAppends();
    const standingCancel = (i: number, type: string) => type === "run.cancelled" && i >= active.seedCount;
    for (;;) {
      // A cancel this execution already KNOWS about (the tailer delivered it, or
      // a raced read below folded it) is just as standing as an unseen one.
      if (active.records.some((r) => standingCancel(r.i, r.ev.type))) {
        return events.some((ev) => ev.type === "run.cancelled");
      }
      // Fast path: when this runtime has seen a CONTIGUOUS prefix of the journal
      // there is nothing unseen to yield to — CAS at our own count, no re-read.
      let maxIdx = -1;
      for (const i of active.seen) if (i > maxIdx) maxIdx = i;
      if (active.seen.size === maxIdx + 1) {
        const appended = await this.journal.appendIf(rt.runId, maxIdx + 1, events);
        if (appended) {
          this.onRecords(rt, appended);
          return true;
        }
      }
      // Records we have not seen stand between us and the terminal: fold them.
      let count = 0;
      let cancelled = false;
      for await (const rec of this.journal.read(rt.runId)) {
        count++;
        if (standingCancel(rec.i, rec.ev.type)) cancelled = true;
      }
      if (cancelled) {
        // Committed in the tailer's blind spot: our own cancel echo has nothing
        // to add, and any other terminal must yield to it.
        return events.some((ev) => ev.type === "run.cancelled");
      }
      const appended = await this.journal.appendIf(rt.runId, count, events);
      if (appended) {
        this.onRecords(rt, appended);
        return true;
      }
    }
  }

  /** The run's ownership claim now belongs to another process: stop this copy. */
  private fenceLostRun(active: ActiveRun): void {
    if (active.leaseTimer) clearInterval(active.leaseTimer);
    active.tail?.abort();
    active.runtime.fence(
      new StepError(
        "detached",
        `run ${active.runtime.runId}: ownership claim lost to another process — stopping this copy without a journaled outcome`,
        { step: { kind: "workflow", runId: active.runtime.runId } },
      ),
    );
  }

  private outcomeOf(active: ActiveRun): Promise<RunOutcome> {
    return new Promise<RunOutcome>((resolve) => {
      const onIdle = () => {
        const status = active.runtime.status;
        if (status === "waiting_for_human" || status === "waiting_for_signal") {
          active.runtime.offIdle(onIdle);
          resolve({ status, pending: [...active.pending.values()] });
        }
      };
      active.runtime.onIdle(onIdle);
      active.result
        .then((output) => resolve({ status: "complete", output }))
        .catch((err) => {
          if (isCancellation(err)) resolve({ status: "cancelled" });
          else resolve({ status: "failed", error: StepError.from(err) });
        })
        .finally(() => active.runtime.offIdle(onIdle));
    });
  }

  private async drive(active: ActiveRun, def: WorkflowDefinition, input: unknown): Promise<unknown> {
    const rt = active.runtime;
    const span = tracer.startSpan(`weft.run ${rt.workflowName}`, {
      attributes: { "weft.run_id": rt.runId, "weft.workflow": rt.workflowName },
    });
    try {
      rt.setStatus("executing");
      const ctx = buildCtx(rt);
      const rawOutput = await def.run(ctx, input);
      // Structured-cloneable is not enough: the journal is JSONL, and a Map quietly
      // becomes {}, a bigint makes stringify throw — the live handle would then
      // disagree with state.json and replay, or a green run would fail at append.
      const rawBad = jsonUnsafeAt(rawOutput);
      if (rawBad !== undefined) {
        throw new StepError(
          "invalid_output",
          `workflow result cannot be journaled as JSON at ${rawBad}; did you forget to await a step?`,
          { step: { kind: "workflow", runId: rt.runId } },
        );
      }
      const outputCheck = await validateSchema(def.meta.output, rawOutput);
      if (!outputCheck.ok) {
        throw new StepError(
          "invalid_output",
          `output failed the workflow's output schema: ${outputCheck.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
          { step: { kind: "workflow", runId: rt.runId } },
        );
      }
      // Schema transforms run after the raw check and can re-introduce such values.
      const checkedBad = jsonUnsafeAt(outputCheck.value);
      if (checkedBad !== undefined) {
        throw new StepError(
          "invalid_output",
          `workflow output cannot be journaled as JSON at ${checkedBad} (introduced by a schema transform?)`,
          { step: { kind: "workflow", runId: rt.runId } },
        );
      }
      const dangling = [...rt.patches.values()].filter((p) => !p.integrated && !p.discarded);
      if (dangling.length > 0) {
        throw new StepError(
          "unintegrated_patches",
          `run ended with ${dangling.length} un-integrated patch(es) (${dangling.map((p) => p.key).join(", ")}) — call ctx.integrate([...]) or ctx.discard([...])`,
          { step: { kind: "workflow", runId: rt.runId } },
        );
      }
      if (rt.requiredCheckFailures.length > 0) {
        throw new StepError(
          "check_failed",
          `required check(s) failed: ${[...new Set(rt.requiredCheckFailures)].join(", ")}`,
          { step: { kind: "workflow", runId: rt.runId } },
        );
      }
      const landed = await this.appendTerminal(active, [
        { type: "run.completed", output: outputCheck.value },
      ]);
      if (!landed) throw new CancelledError(`run ${rt.runId} was cancelled`);
      rt.status = "complete";
      return outputCheck.value;
    } catch (err) {
      // Fenced BEFORE cancellation: the journal is not ours to write a terminal
      // event into (its next owner resumes from the last committed record), and a
      // fence-driven abort surfacing as a CancelledError must not journal
      // run.cancelled either. The fence is the cause; the unwind error is its echo.
      if (rt.fenced) throw rt.fenced;
      if (isCancellation(err)) {
        // appendTerminal dedupes: an external cancel already committed its
        // run.cancelled, and a second one would just be noise.
        await this.appendTerminal(active, [{ type: "run.cancelled" }]);
        rt.status = "cancelled";
        throw err;
      }
      const stepError = StepError.from(err, { kind: "workflow", runId: rt.runId });
      const landedFail = await this.appendTerminal(active, [
        { type: "run.failed", error: stepError.serialize() },
      ]);
      if (!landedFail) {
        // A committed cancellation outranks the local failure.
        rt.status = "cancelled";
        throw new CancelledError(`run ${rt.runId} was cancelled`);
      }
      rt.status = "failed";
      throw stepError;
    } finally {
      span.end();
      // Release inside this finally (not the detached cleanup chain) so anything that
      // awaited result — a cancel, a test about to resume elsewhere — sees it free.
      if (active.leaseTimer) clearInterval(active.leaseTimer);
      await active.lease?.release().catch(() => undefined);
      // A fenced run's projections belong to its new owner — don't clobber them.
      if (!rt.fenced) await this.snapshot(active).catch(() => undefined);
    }
  }

  // -- EngineHost -----------------------------------------------------------

  onRecords(runtime: RunRuntime, records: JournalRecord[]): void {
    const active = this.active.get(runtime.runId);
    if (!active) return;
    active.records.push(...records);
    for (const rec of records) active.seen.add(rec.i);
    active.sinceSnapshot += records.length;
    const important = records.some(
      (r) =>
        r.ev.type === "run.status" ||
        r.ev.type === "run.completed" ||
        r.ev.type === "run.failed" ||
        r.ev.type === "human.requested",
    );
    if (important || active.sinceSnapshot >= 25) {
      active.sinceSnapshot = 0;
      void this.snapshot(active).catch(() => undefined);
    }
  }

  /**
   * Consume run-directed events appended after launch, whichever process wrote
   * them. Deliveries are idempotent (an answer this process already resolved is a
   * no-op), and signal delivery happens ONLY here so a payload is never delivered
   * twice. This coordinates delivery to the owner, not concurrent execution: two
   * processes must still not RUN the same run at once.
   */
  private async tailExternalEvents(active: ActiveRun, fromIndex: number, signal: AbortSignal): Promise<void> {
    try {
      for await (const rec of this.journal.watch(active.runtime.runId, { fromIndex, signal })) {
        // Externally appended records belong in the active projection too, or the
        // terminal snapshot describes an answered request as still pending.
        if (!active.seen.has(rec.i)) {
          active.seen.add(rec.i);
          active.records.push(rec);
          active.sinceSnapshot++;
        }
        const ev = rec.ev;
        if (ev.type === "human.answered") {
          active.runtime.deliverAnswer(ev.id, structuredClone(ev.answer), ev.answeredBy);
        } else if (ev.type === "signal.received") {
          active.runtime.deliverSignal(ev.name, structuredClone(ev.payload));
        } else if (ev.type === "run.cancelled") {
          active.runtime.externalCancel();
        }
      }
    } catch {
      // the tailer dies silently when the watch is aborted or the store goes away
    }
  }

  private snapshot(active: ActiveRun): Promise<void> {
    // Serialized per run: parallel snapshot writers could publish an OLDER reduction
    // after a newer one and leave projections stale. Each queued pass re-reduces the
    // then-current records (index-sorted — tailed external records can land out of
    // order), so later publications always cover at least what earlier ones did.
    const next = active.snapshotChain.then(async () => {
      const state = reduceState([...active.records].sort((a, b) => a.i - b.i));
      await this.journal.snapshot(active.runtime.runId, {
        state,
        tree: renderTree(state),
        report: renderReport(state),
      });
    });
    active.snapshotChain = next.catch(() => undefined);
    return next;
  }

  registerPending(runtime: RunRuntime, request: PendingRequest): void {
    this.active.get(runtime.runId)?.pending.set(request.id, request);
  }

  resolvePending(runtime: RunRuntime, id: string): void {
    this.active.get(runtime.runId)?.pending.delete(id);
  }

  async executeChildRun(spec: ChildRunSpec): Promise<{ output: unknown; usage: import("@weft/sdk").Usage }> {
    const parent = spec.parent;
    let def: WorkflowDefinition | undefined;
    if (spec.def !== undefined) {
      if (!isWorkflowDefinition(spec.def)) {
        throw new StepError("invalid_input", `ctx.workflow: not a workflow definition`, {
          step: { kind: "workflow", key: spec.key ?? spec.name, runId: parent.runId },
        });
      }
      def = spec.def;
    } else {
      def = await this.registry?.get(spec.name);
    }
    if (!def) {
      throw new StepError("invalid_input", `workflow "${spec.name}" not found in the registry`, {
        step: { kind: "workflow", key: spec.key ?? spec.name, runId: parent.runId },
      });
    }

    const shared: SharedRunResources = {
      budget: spec.budget ? parent.shared.budget.child(spec.budget) : parent.shared.budget,
      abort: parent.shared.abort,
      agentCounter: parent.shared.agentCounter,
      reuse: parent.shared.reuse,
    };

    const childId = spec.childRunId;
    const resuming = await this.journal.exists(childId);
    // Journaled raw, validated on EVERY execution (mirrors start/resume): the
    // journal's JSON can't hold a transform's output faithfully, so a resumed
    // child must see the schema reapplied, not the serialized residue.
    let rawInput = spec.input === undefined ? {} : spec.input;
    const records: JournalRecord[] = [];
    let replay: ReplayIndex | undefined;
    if (resuming) {
      for await (const rec of this.journal.read(childId)) records.push(rec);
      const created = records.find((r) => r.ev.type === "run.created")?.ev;
      if (created?.type === "run.created") rawInput = created.input === undefined ? {} : created.input;
      replay = ReplayIndex.fromRecords(records);
      // The child's own journaled spend charges up the shared chain. The parent's
      // restore never saw it (a workflow step journals its usage only at
      // completion, and a completed child is served, not resumed) — no double count.
      shared.budget.restore(replay.totalUsage.tokens, replay.totalUsage.usd, replay.totalUsage.samples);
    } else {
      const rawBad = jsonUnsafeAt(rawInput);
      if (rawBad !== undefined) {
        throw new StepError(
          "invalid_input",
          `input for "${spec.name}" cannot be journaled as JSON at ${rawBad} — child inputs are journaled raw and re-validated on resume`,
          { step: { kind: "workflow", key: spec.key ?? spec.name, runId: parent.runId } },
        );
      }
    }
    const check = await validateSchema(def.meta.input, rawInput);
    if (!check.ok) {
      throw new StepError(
        "invalid_input",
        `input failed ${spec.name}'s input schema: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        { step: { kind: "workflow", key: spec.key ?? spec.name, runId: parent.runId } },
      );
    }
    const input = check.value;

    const runtime = new RunRuntime({
      host: this,
      runId: childId,
      workflowName: def.meta.name ?? spec.name,
      cwd: parent.cwd,
      depth: parent.depth + 1,
      shared,
      ...(replay !== undefined ? { replay } : {}),
      ...(parent.baseRef !== undefined ? { baseRef: parent.baseRef } : {}),
      ...(def.meta.defaults !== undefined ? { workflowDefaults: def.meta.defaults } : {}),
    });
    if (!resuming) {
      // Seed launch with the appended record for the same reason start() does: the
      // child is not in the active map yet, so onRecords drops run.created otherwise.
      const created = await runtime.append([
        {
          type: "run.created",
          runId: childId,
          workflow: { name: def.meta.name ?? spec.name },
          input: rawInput,
          cwd: parent.cwd,
          depth: parent.depth + 1,
          parentRunId: parent.runId,
          ...(parent.baseRef !== undefined ? { baseRef: parent.baseRef } : {}),
        },
      ]);
      records.push(...created);
    }
    const lease = await this.claimRun(childId);
    const handle = this.launch(runtime, def, input, records, lease);
    const childActive = this.active.get(childId);
    try {
      const output = await handle.result;
      // The child's total journaled spend rides on the parent's workflow step so a
      // later parent resume restores it without reading the child journal. Failed
      // attempts count too — their spend lives on retry/failure records.
      const usage = { input: 0, output: 0, usd: 0 };
      const fold = (u: import("@weft/sdk").Usage | undefined) => {
        if (!u) return;
        usage.input += u.input ?? 0;
        usage.output += u.output ?? 0;
        usage.usd += u.usd ?? 0;
      };
      for (const rec of childActive?.records ?? []) {
        if (rec.ev.type === "step.completed") fold(rec.ev.usage);
        else if (rec.ev.type === "step.attempt") fold(rec.ev.usage);
        else if (rec.ev.type === "step.failed")
          fold((rec.ev.error.detail as { usage?: import("@weft/sdk").Usage } | undefined)?.usage);
      }
      return { output, usage };
    } catch (err) {
      throw StepError.from(err, { kind: "workflow", key: spec.key ?? spec.name, runId: parent.runId });
    } finally {
      this.active.delete(childId);
    }
  }

  // -- external interactions ------------------------------------------------

  async answer(
    runId: string,
    requestId: string,
    answer: unknown,
    opts: { channel?: string } = {},
  ): Promise<void> {
    // Same contract as signal payloads: the answer rides the JSONL journal, so a
    // Map/Date would replay differently than the live waiter saw it, and a
    // bigint or cycle would blow up the append itself. Refuse before either path.
    const answerBad = jsonUnsafeAt(answer ?? null);
    if (answerBad !== undefined) {
      throw new StepError(
        "invalid_answer",
        `answer to ${requestId} cannot be journaled as JSON at ${answerBad}`,
        { step: { kind: "human", key: requestId, runId } },
      );
    }
    const active = this.active.get(runId);
    if (active) {
      const wait = active.runtime.pendingWait(requestId);
      if (!wait) throw new Error(`run ${runId}: no pending request ${requestId}`);
      const issues = structuralCheck(wait.request.schema, answer);
      if (issues.length > 0) {
        throw new StepError(
          "invalid_answer",
          `answer does not match the request schema: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
          { step: { kind: "human", key: requestId, runId } },
        );
      }
      if (wait.realSchema) {
        const { unwrapWireValue } = await import("./jsonschema.ts");
        const check = await validateSchema(wait.realSchema, unwrapWireValue(answer, wait.wrapped));
        if (!check.ok) {
          throw new StepError(
            "invalid_answer",
            `answer failed schema validation: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
            { step: { kind: "human", key: requestId, runId } },
          );
        }
      }
      await active.runtime.append([
        {
          type: "human.answered",
          id: requestId,
          answer,
          answeredBy: "human",
          ...(opts.channel ? { channel: opts.channel } : {}),
        },
      ]);
      active.runtime.resolveAnswer(requestId, answer, "human");
      return;
    }
    // Suspended run in another (or no) process: validate structurally and append; resume serves it.
    const records: JournalRecord[] = [];
    for await (const rec of this.journal.read(runId)) records.push(rec);
    if (records.length === 0) throw new Error(`run ${runId} not found`);
    const request = records.find((r) => r.ev.type === "human.requested" && r.ev.id === requestId)?.ev;
    if (request?.type !== "human.requested") throw new Error(`run ${runId}: no request ${requestId}`);
    // An answer stands unless the owner journaled a rejection after it — then the
    // request is open again and a replacement is expected.
    let standing = false;
    for (const r of records) {
      if (r.ev.type === "human.answered" && r.ev.id === requestId) standing = true;
      else if (r.ev.type === "human.rejected" && r.ev.id === requestId) standing = false;
    }
    if (standing) throw new Error(`run ${runId}: request ${requestId} is already answered`);
    const issues = structuralCheck(request.schema, answer);
    if (issues.length > 0) {
      throw new StepError(
        "invalid_answer",
        `answer does not match the request schema: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        { step: { kind: "human", key: requestId, runId } },
      );
    }
    await this.journal.append(runId, [
      {
        type: "human.answered",
        id: requestId,
        answer,
        answeredBy: "human",
        ...(opts.channel ? { channel: opts.channel } : {}),
      },
    ]);
  }

  async signal(runId: string, name: string, payload: unknown): Promise<void> {
    // The payload rides the JSONL journal to its waiter: a bigint or cycle would
    // make the append itself throw mid-batch, and a Map/Set/Date would journal
    // lossily — a resumed run would then replay a different value than the live
    // waiter saw. Refuse up front, before either append path.
    const payloadBad = jsonUnsafeAt(payload ?? null);
    if (payloadBad !== undefined) {
      throw new StepError(
        "invalid_input",
        `signal "${name}" payload cannot be journaled as JSON at ${payloadBad}`,
        { step: { kind: "signal", key: name, runId } },
      );
    }
    // Append only: the OWNING engine's journal tailer is the single delivery point
    // (buffering when no waiter is registered yet), whichever process appended.
    const active = this.active.get(runId);
    if (active) {
      await active.runtime.append([{ type: "signal.received", name, payload }]);
      return;
    }
    if (!(await this.journal.exists(runId))) throw new Error(`run ${runId} not found`);
    await this.journal.append(runId, [{ type: "signal.received", name, payload }]);
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (active) {
      active.runtime.shared.abort.abort(new CancelledError());
      // Reject (never answer) pending human waits: the run must end cancelled,
      // not proceed as if someone had denied the request.
      active.runtime.cancelHumanWaits();
      await active.result.catch(() => undefined);
      return;
    }
    if (!(await this.journal.exists(runId))) throw new Error(`run ${runId} not found`);
    // Fold the journal first: a stale cancel must never overwrite a recorded outcome
    // (a "cancelled" projection over a run.completed output misreports the run).
    // The fold and the append must be ONE atomic operation against other processes:
    // the run's owner can commit run.completed inside the read/write gap, and an
    // unconditional append would then flip that successful run's final projection
    // to cancelled. appendIf re-checks the record count under the store's append
    // lock; a lost race re-folds (and usually finds the terminal it lost to).
    for (;;) {
      let status: "open" | "complete" | "failed" | "cancelled" = "open";
      let count = 0;
      for await (const rec of this.journal.read(runId)) {
        count++;
        if (rec.ev.type === "run.completed") status = "complete";
        else if (rec.ev.type === "run.failed") status = "failed";
        else if (rec.ev.type === "run.cancelled") status = "cancelled";
        else if (rec.ev.type === "run.status" && rec.ev.status !== "cancelled") status = "open";
      }
      if (status === "cancelled") return; // idempotent
      if (status !== "open") throw new Error(`run ${runId} is already ${status}`);
      const events: JournalEvent[] = [{ type: "run.cancelled" }, { type: "run.status", status: "cancelled" }];
      if (!this.journal.appendIf) {
        // No conditional append: accept the race (single-process hosts don't race themselves).
        await this.journal.append(runId, events);
        return;
      }
      if (await this.journal.appendIf(runId, count, events)) return;
    }
  }

  /**
   * Detach from every active run WITHOUT ending it: stop tailers and deadline
   * timers, abort and DRAIN in-flight work, then release ownership claims. The
   * runs stay resumable (no terminal event is journaled) — this is what a host
   * calls right before its process exits (a CLI whose run just suspended, a
   * daemon stopping), and what a test uses to simulate a crashed owner. The
   * drain must come before the release: a claim released while a step is still
   * executing would let another process resume the run while this one keeps
   * appending and mutating the repository. Each run's handle rejects with a
   * "detached" StepError; a step that ignores its abort signal past the drain
   * window forfeits the release and its claim TTL-expires instead.
   */
  async shutdown(): Promise<void> {
    const actives = [...this.active.values()];
    this.active.clear();
    for (const active of actives) {
      if (active.leaseTimer) clearInterval(active.leaseTimer);
      active.tail?.abort();
      // Fencing rejects pending waits, disarms human-deadline timers (a live timer
      // here would keep the process alive and could answer a run someone else now
      // executes), aborts step work, and refuses every journal append from now on.
      active.runtime.fence(
        new StepError(
          "detached",
          `run ${active.runtime.runId}: the host shut down; the run stays resumable in another process`,
          { step: { kind: "workflow", runId: active.runtime.runId } },
        ),
      );
    }
    for (const active of actives) {
      const drained = await Promise.race([
        active.result.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5_000);
          timer.unref?.();
        }),
      ]);
      if (!drained) continue; // never release ownership over still-live work
      await active.runtime.flushAppends();
      // Releases are owner-checked, so drive()'s own release (already run by the
      // time result settles) and this one can never evict the run's next claimant.
      await active.lease?.release().catch(() => undefined);
    }
  }

  // -- inspection -----------------------------------------------------------

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  async state(runId: string): Promise<RunState> {
    const active = this.active.get(runId);
    if (active) return reduceState([...active.records].sort((a, b) => a.i - b.i));
    const records: JournalRecord[] = [];
    for await (const rec of this.journal.read(runId)) records.push(rec);
    if (records.length === 0) throw new Error(`run ${runId} not found`);
    return reduceState(records);
  }

  async report(runId: string): Promise<string> {
    return renderReport(await this.state(runId));
  }

  async pending(runId: string): Promise<PendingRequest[]> {
    const state = await this.state(runId);
    return state.humans
      .filter((h) => h.status === "pending")
      .map((h) => ({
        runId,
        id: h.id,
        kind: h.kind as PendingRequest["kind"],
        question: h.question,
        schema: h.schema,
        createdAt: h.requestedAt,
        ...(h.detail !== undefined ? { detail: h.detail } : {}),
        ...(h.risk !== undefined ? { risk: h.risk } : {}),
        ...(h.deadline !== undefined ? { deadline: h.deadline } : {}),
        ...(h.confirmToken !== undefined ? { confirmToken: h.confirmToken } : {}),
      }));
  }

  async list(filter?: RunListFilter): Promise<RunSummary[]> {
    return this.journal.list(filter);
  }

  watch(runId: string, opts?: { fromIndex?: number; signal?: AbortSignal }): AsyncIterable<JournalRecord> {
    return this.journal.watch(runId, opts);
  }

  /** Convenience for tests and hosts: register a provider after construction. */
  registerProvider(provider: AgentProvider): this {
    this.providers.register(provider);
    return this;
  }

  /**
   * replay --dry: re-execute the code against the journal without calling any
   * provider or appending any event. Reports what a real resume would reuse.
   */
  async replayDry(
    runId: string,
    opts: ResumeOptions = {},
  ): Promise<{
    hits: number;
    salvaged: number;
    diverged: Array<{ seq?: number; key?: string; kind?: string }>;
    pendingRequests: string[];
    completed: boolean;
  }> {
    const records: JournalRecord[] = [];
    for await (const rec of this.journal.read(runId)) records.push(rec);
    if (records.length === 0) throw new Error(`run ${runId} not found`);
    const created = records.find((r) => r.ev.type === "run.created")?.ev;
    if (created?.type !== "run.created") throw new Error(`run ${runId}: missing run.created`);
    let def = opts.def;
    if (!def && this.registry) def = await this.registry.get(created.workflow.name);
    if (!def) throw new Error(`run ${runId}: no definition for "${created.workflow.name}"`);

    const runtime = new RunRuntime({
      host: this,
      runId,
      workflowName: created.workflow.name,
      cwd: created.cwd,
      depth: created.depth,
      shared: {
        budget: new Budget({}),
        abort: new AbortController(),
        agentCounter: { count: 0, warned: false },
        reuse: opts.reuse ?? "content",
      },
      replay: ReplayIndex.fromRecords(records),
      dry: true,
      ...(created.baseRef !== undefined ? { baseRef: created.baseRef } : {}),
      ...(def.meta.defaults !== undefined ? { workflowDefaults: def.meta.defaults } : {}),
    });
    // Same input the real resume would hand the code: raw from the journal, schema reapplied.
    const inputCheck = await validateSchema(def.meta.input, created.input === undefined ? {} : created.input);
    if (!inputCheck.ok) {
      throw new StepError(
        "invalid_input",
        `input failed ${created.workflow.name}'s input schema on replay: ${inputCheck.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        { step: { kind: "workflow", runId } },
      );
    }
    let completed = false;
    try {
      const ctx = buildCtx(runtime);
      await def.run(ctx, inputCheck.value);
      completed = true;
    } catch (err) {
      if (!isCancellation(err)) {
        // A real (journaled) failure replays as thrown code paths too; report, don't crash.
        runtime.dryDiverged.push({ kind: "error", key: (err as Error).message.slice(0, 80) });
      }
    }
    return {
      hits: runtime.hitCount,
      salvaged: runtime.salvageCount,
      diverged: runtime.dryDiverged.map((d) => ({
        ...(d.seq !== undefined ? { seq: d.seq } : {}),
        ...(d.key !== undefined ? { key: d.key } : {}),
        ...(d.kind !== undefined ? { kind: d.kind } : {}),
      })),
      pendingRequests: [...runtime.dryPending],
      completed,
    };
  }
}
