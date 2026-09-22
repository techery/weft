import {
  type OperationDefinition,
  type OperationOptions,
  type OperationReceipt,
  parseDuration,
  type Risk,
  StepError,
  validateSchema,
  type WorkspaceCandidate,
} from "@techery/weft-sdk";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { jsonUnsafeAt } from "./jsonschema.ts";
import type { RunRuntime } from "./runtime.ts";
import { MAX_TIMER_MS } from "./runtime.ts";

async function hostCall<T>(
  rt: RunRuntime,
  signal: AbortSignal,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (error: Error) => void = () => undefined;
  const onAbort = () => {
    abort.abort();
    rejectAbort(new Error("operation interrupted"));
  };
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const deadline = Date.now() + timeoutMs;
  const arm = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      abort.abort();
      rejectAbort(new Error(`operation timed out after ${timeoutMs}ms`));
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
  };
  try {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    arm();
    const actual = Promise.resolve().then(() => {
      if (abort.signal.aborted) throw new Error("operation interrupted");
      return fn(abort.signal);
    });
    let calls = liveCalls.get(rt.shared.abort);
    if (!calls) {
      calls = new Set();
      liveCalls.set(rt.shared.abort, calls);
    }
    calls.add(actual);
    const settled = () => {
      calls!.delete(actual);
    };
    void actual.then(settled, settled);
    return await Promise.race([actual, interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

// Children share their root's abort controller and may also share its checkout.
// Keep every ancestor's ownership claim while any adapter in that tree can still
// land an effect, including after the child's workflow promise has timed out.
const liveCalls = new WeakMap<AbortController, Set<Promise<unknown>>>();
/** Outstanding adapters in this run's tree, including those that ignored cancellation. */
export function pendingOperationCalls(rt: RunRuntime): readonly Promise<unknown>[] {
  return [...(liveCalls.get(rt.shared.abort) ?? [])];
}

export interface OperationContext {
  runId: string;
  requestId: string;
  cwd: string;
  signal: AbortSignal;
  candidate?: WorkspaceCandidate;
  checks?: readonly string[];
}

export type ReconciledOperation =
  | { status: "applied"; output: unknown }
  | { status: "not_applied" }
  | { status: "unknown"; detail: string; resources?: readonly string[] };

/** Trusted host implementation. Reconcile must establish absence before a retry is admitted. */
export interface OperationBinding {
  risk: Risk;
  /** Refuse generic operation calls: this binding requires host-verified delivery evidence. */
  delivery?: boolean;
  requiredChecks?: readonly string[];
  execute(input: unknown, context: OperationContext): Promise<unknown>;
  reconcile(input: unknown, context: OperationContext): Promise<ReconciledOperation>;
}

export type OperationBindings = Readonly<Record<string, OperationBinding>>;
const activeRequests = new WeakMap<RunRuntime, Set<string>>();

export type OperationEvent =
  | {
      type: "operation.intent";
      requestId: string;
      binding: string;
      digest: string;
      key: string;
      input: unknown;
    }
  | {
      type: "operation.receipt";
      requestId: string;
      binding: string;
      digest: string;
      output: unknown;
      reconciled: boolean;
    }
  | {
      type: "operation.unknown";
      requestId: string;
      binding: string;
      detail: string;
      resources?: readonly string[];
    };

export async function runOperation<I, O, P>(
  rt: RunRuntime,
  definition: OperationDefinition<I, O, P>,
  input: I,
  options: OperationOptions,
  beforeExecute?: () => Promise<void>,
  delivery?: { candidate: WorkspaceCandidate; checks: readonly string[] },
): Promise<OperationReceipt<O>> {
  if (definition?.kind !== "weft.operation" || !options?.key?.trim())
    throw new StepError("invalid_input", "operation requires a definition and stable key");
  const binding = rt.host.operations?.[definition.binding];
  if (!binding)
    throw new StepError("invalid_input", `no host operation binding registered for ${definition.binding}`);
  const risks: Risk[] = ["low", "medium", "high", "irreversible"];
  if (!risks.includes(binding.risk) || !risks.includes(definition.risk))
    throw new StepError("invalid_input", "operation risk must be a known risk tier");
  if (binding.delivery && !delivery)
    throw new StepError("check_failed", `${definition.binding} must be invoked through ctx.delivery`);
  if (binding.requiredChecks?.some((name) => !delivery?.checks.includes(name)))
    throw new StepError(
      "check_failed",
      `${definition.binding} requires checks: ${binding.requiredChecks.join(", ")}`,
    );
  const checked = await validateSchema(definition.input, input);
  if (!checked.ok)
    throw new StepError("invalid_input", `operation ${definition.name}: invalid input`, {
      detail: checked.issues,
    });
  if (jsonUnsafeAt(checked.value) !== undefined)
    throw new StepError("invalid_input", "operation input must be JSON serializable");
  // Bind the exact bytes observed before any authorization wait; caller-owned objects may change later.
  const payload = JSON.parse(canonicalJson(checked.value)) as unknown;
  const key = rt.resolveKey(options.key)!;
  const timeoutMs =
    options.timeout === undefined ? rt.host.config.limits.execTimeoutMs : parseDuration(options.timeout);
  const requestId = options.requestId ?? `${rt.runId}:${key}`;
  if (!requestId.trim()) throw new StepError("invalid_input", "operation requestId must not be empty");
  let requests = activeRequests.get(rt);
  if (!requests) {
    requests = new Set();
    activeRequests.set(rt, requests);
  }
  if (requests.has(requestId))
    throw new StepError("invalid_input", `duplicate operation requestId ${requestId}`);
  requests.add(requestId);
  const digest = sha256Hex(
    canonicalJson({
      binding: definition.binding,
      revision: definition.revision,
      input: payload,
      ...(delivery
        ? {
            candidate: {
              id: delivery.candidate.id,
              repository: delivery.candidate.repository,
              branch: delivery.candidate.branch,
              head: delivery.candidate.head,
              tree: delivery.candidate.tree,
            },
          }
        : {}),
    }),
  );
  const prior: OperationEvent[] = [];
  for await (const record of rt.host.journal.read(rt.runId)) {
    if (record.ev.type.startsWith("operation.") && (record.ev as OperationEvent).requestId === requestId)
      prior.push(record.ev as OperationEvent);
  }
  const intent = prior.find(
    (event): event is Extract<OperationEvent, { type: "operation.intent" }> =>
      event.type === "operation.intent",
  );
  const receipt = prior.find(
    (event): event is Extract<OperationEvent, { type: "operation.receipt" }> =>
      event.type === "operation.receipt",
  );
  if (intent && (intent.digest !== digest || intent.binding !== definition.binding))
    throw new StepError(
      "invalid_input",
      `operation request ${requestId} was already used for different input or semantics`,
    );
  if (receipt && (!intent || receipt.digest !== digest || receipt.binding !== definition.binding))
    throw new StepError("recovery_required", `operation ${requestId} has a receipt without matching intent`);
  const revive = async (output: unknown, reconciled: boolean): Promise<OperationReceipt<O>> => {
    const result = await validateSchema(definition.output, output);
    if (!result.ok)
      throw new StepError("recovery_required", `operation ${requestId} has an incompatible recorded output`, {
        detail: result.issues,
      });
    return Object.freeze({ value: result.value as O, requestId, binding: definition.binding, reconciled });
  };
  const uncertain = async (detail: string, resources?: readonly string[]): Promise<never> => {
    await rt.append([
      {
        type: "operation.unknown",
        requestId,
        binding: definition.binding,
        detail,
        ...(resources ? { resources } : {}),
      },
    ]);
    throw new StepError(
      "recovery_required",
      `operation ${requestId}: ${detail}; inspect the operation and resume to reconcile`,
      { detail: { requestId, binding: definition.binding, resources: resources ?? [] } },
    );
  };
  return rt.runStep({
    kind: "sideeffect",
    key: options.key,
    label: `operation:${definition.name}`,
    payload: { operation: definition.binding, requestId, digest },
    verifyServe: async () => false,
    execute: async (io) => {
      if (receipt) return { value: await revive(receipt.output, receipt.reconciled) };
      const context: OperationContext = {
        runId: rt.runId,
        requestId,
        cwd: rt.cwd,
        signal: io.signal,
        ...(delivery ? { candidate: delivery.candidate, checks: delivery.checks } : {}),
      };
      let output: unknown;
      let reconciled = false;
      let execute = true;
      if (intent) {
        let observed: ReconciledOperation;
        try {
          observed = await hostCall(rt, io.signal, timeoutMs, (signal) =>
            binding.reconcile(structuredClone(payload), { ...context, signal }),
          );
        } catch (error) {
          return uncertain(`reconciliation failed: ${String(error)}`);
        }
        if (!observed || !["applied", "not_applied", "unknown"].includes(observed.status)) {
          return uncertain("host reconciler returned an invalid outcome; absence is not established");
        }
        if (observed.status === "unknown") return uncertain(observed.detail, observed.resources);
        if (observed.status === "applied") {
          output = observed.output;
          reconciled = true;
          execute = false;
        }
      }
      if (execute) {
        // Recheck both before and after a human wait. Approval cannot authorize later code.
        await beforeExecute?.();
        const risk = risks[Math.max(risks.indexOf(definition.risk), risks.indexOf(binding.risk))]!;
        const gate = await rt.gateStep({
          key: `${options.key}:authorize:${digest}`,
          action: definition.name,
          risk,
          detail: `Request ${requestId}\nInput digest ${digest}`,
        });
        if (!gate.approved) throw new StepError("gate_denied", `operation ${definition.name} denied`);
        await beforeExecute?.();
        if (!intent)
          await rt.append([
            { type: "operation.intent", requestId, binding: definition.binding, digest, key, input: payload },
          ]);
        try {
          output = await hostCall(rt, io.signal, timeoutMs, (signal) =>
            binding.execute(structuredClone(payload), { ...context, signal }),
          );
        } catch (error) {
          // The host may have committed before reporting failure, including cancellation.
          if (io.signal.aborted) throw error;
          return uncertain(`execution outcome is unknown: ${String(error)}`);
        }
      }
      const value = await revive(output, reconciled);
      if (jsonUnsafeAt(output) !== undefined || jsonUnsafeAt(value.value) !== undefined)
        return uncertain("operation output is not JSON serializable");
      // This receipt survives a crash before the ordinary step completion is appended.
      await rt.append([
        { type: "operation.receipt", requestId, binding: definition.binding, digest, output, reconciled },
      ]);
      return { value };
    },
  });
}
