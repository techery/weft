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
import type { JournalRecord, RunStatus } from "./events.ts";
import { structuralCheck } from "./jsonschema.ts";
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
import type { BlobStore, JournalStore, RunListFilter, RunSummary } from "./stores.ts";

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
  result: Promise<unknown>;
  pending: Map<string, PendingRequest>;
  sinceSnapshot: number;
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
    const inputCheck = await validateSchema(def.meta.input, opts.input ?? {});
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
    await runtime.append([
      {
        type: "run.created",
        runId,
        workflow: { name, ...(opts.defHash !== undefined ? { defHash: opts.defHash } : {}) },
        input: inputCheck.value,
        cwd: opts.cwd,
        depth: 0,
        ...(opts.baseRef !== undefined ? { baseRef: opts.baseRef } : {}),
        ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
      },
    ]);
    return this.launch(runtime, def, inputCheck.value);
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
    if (!created || created.type !== "run.created") throw new Error(`run ${runId}: missing run.created`);

    let def = opts.def;
    if (!def && this.registry) def = await this.registry.get(created.workflow.name);
    if (!def) {
      throw new Error(
        `run ${runId}: no definition for "${created.workflow.name}" (pass def or configure a registry)`,
      );
    }

    const replay = ReplayIndex.fromRecords(records);
    const shared: SharedRunResources = {
      // The journaled ceiling survives resume; spend restores from journaled usage.
      budget: new Budget(created.budget ?? {}),
      abort: new AbortController(),
      agentCounter: { count: 0, warned: false },
      reuse: opts.reuse ?? "content",
    };
    shared.budget.restore(replay.totalUsage.tokens, replay.totalUsage.usd);
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
    return this.launch(runtime, def, created.input, records);
  }

  private launch(
    runtime: RunRuntime,
    def: WorkflowDefinition,
    input: unknown,
    priorRecords: JournalRecord[] = [],
  ): RunHandle {
    const active: ActiveRun = {
      runtime,
      def,
      records: [...priorRecords],
      pending: new Map(),
      sinceSnapshot: 0,
      result: undefined as never,
    };
    this.active.set(runtime.runId, active);
    active.result = this.drive(active, def, input);
    // Observed via handle/outcome — avoid unhandledRejection; chain the cleanup off
    // the caught promise so the .finally() derivative can never reject unobserved.
    // Entries persist while suspended; at terminal state a later resume() must
    // replay instead of returning the settled promise, and records[] is freed.
    void active.result
      .catch(() => undefined)
      .finally(() => {
        if (this.active.get(runtime.runId) === active) this.active.delete(runtime.runId);
      });
    return {
      runId: runtime.runId,
      result: active.result,
      outcome: () => this.outcomeOf(active),
    };
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
      try {
        structuredClone(rawOutput);
      } catch {
        throw new StepError(
          "invalid_output",
          "workflow result must be structured-cloneable; did you forget to await a step?",
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
      await rt.append([{ type: "run.completed", output: outputCheck.value }]);
      rt.status = "complete";
      return outputCheck.value;
    } catch (err) {
      if (isCancellation(err)) {
        await rt.append([{ type: "run.cancelled" }]);
        rt.status = "cancelled";
        throw err;
      }
      const stepError = StepError.from(err, { kind: "workflow", runId: rt.runId });
      await rt.append([{ type: "run.failed", error: stepError.serialize() }]);
      rt.status = "failed";
      throw stepError;
    } finally {
      span.end();
      await this.snapshot(active).catch(() => undefined);
    }
  }

  // -- EngineHost -----------------------------------------------------------

  onRecords(runtime: RunRuntime, records: JournalRecord[]): void {
    const active = this.active.get(runtime.runId);
    if (!active) return;
    active.records.push(...records);
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

  private async snapshot(active: ActiveRun): Promise<void> {
    const state = reduceState(active.records);
    await this.journal.snapshot(active.runtime.runId, {
      state,
      tree: renderTree(state),
      report: renderReport(state),
    });
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
    let input = spec.input;
    const records: JournalRecord[] = [];
    let replay: ReplayIndex | undefined;
    if (resuming) {
      for await (const rec of this.journal.read(childId)) records.push(rec);
      const created = records.find((r) => r.ev.type === "run.created")?.ev;
      if (created?.type === "run.created") input = created.input;
      replay = ReplayIndex.fromRecords(records);
      // The child's own journaled spend charges up the shared chain. The parent's
      // restore never saw it (a workflow step journals its usage only at
      // completion, and a completed child is served, not resumed) — no double count.
      shared.budget.restore(replay.totalUsage.tokens, replay.totalUsage.usd);
    } else {
      const check = await validateSchema(def.meta.input, input ?? {});
      if (!check.ok) {
        throw new StepError(
          "invalid_input",
          `input failed ${spec.name}'s input schema: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
          { step: { kind: "workflow", key: spec.key ?? spec.name, runId: parent.runId } },
        );
      }
      input = check.value;
    }

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
      await runtime.append([
        {
          type: "run.created",
          runId: childId,
          workflow: { name: def.meta.name ?? spec.name },
          input,
          cwd: parent.cwd,
          depth: parent.depth + 1,
          parentRunId: parent.runId,
          ...(parent.baseRef !== undefined ? { baseRef: parent.baseRef } : {}),
        },
      ]);
    }
    const handle = this.launch(runtime, def, input, records);
    const childActive = this.active.get(childId);
    try {
      const output = await handle.result;
      // The child's total journaled spend rides on the parent's workflow step so a
      // later parent resume restores it without reading the child journal.
      const usage = { input: 0, output: 0, usd: 0 };
      for (const rec of childActive?.records ?? []) {
        if (rec.ev.type === "step.completed" && rec.ev.usage) {
          usage.input += rec.ev.usage.input ?? 0;
          usage.output += rec.ev.usage.output ?? 0;
          usage.usd += rec.ev.usage.usd ?? 0;
        }
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
    if (!request || request.type !== "human.requested")
      throw new Error(`run ${runId}: no request ${requestId}`);
    const answered = records.some((r) => r.ev.type === "human.answered" && r.ev.id === requestId);
    if (answered) throw new Error(`run ${runId}: request ${requestId} is already answered`);
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
    const active = this.active.get(runId);
    if (active) {
      await active.runtime.append([{ type: "signal.received", name, payload }]);
      active.runtime.deliverSignal(name, payload);
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
    await this.journal.append(runId, [
      { type: "run.cancelled" },
      { type: "run.status", status: "cancelled" },
    ]);
  }

  // -- inspection -----------------------------------------------------------

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  async state(runId: string): Promise<RunState> {
    const active = this.active.get(runId);
    if (active) return reduceState(active.records);
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
    if (!created || created.type !== "run.created") throw new Error(`run ${runId}: missing run.created`);
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
    let completed = false;
    try {
      const ctx = buildCtx(runtime);
      await def.run(ctx, created.input);
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
