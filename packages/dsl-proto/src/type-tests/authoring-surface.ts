import { defineOperation, type WorkflowCtx, type WorkspaceCtx, withRecovery, z } from "../index.ts";

const protectedOperation = defineOperation({
  name: "type-test-protected-operation",
  binding: "type-test.protected",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ accepted: z.boolean() }).strict(),
  authorization: {
    mode: "required",
    action: "Run the protected type-test operation",
    risk: "high",
  },
});

const cancelOperation = defineOperation({
  name: "type-test-cancel-operation",
  binding: "type-test.cancel",
  input: z.object({ attemptRef: z.string(), primaryIdempotencyKey: z.string() }).strict(),
  output: z.object({ cancelled: z.boolean() }).strict(),
  authorization: { mode: "none" },
});

const recoverableOperation = withRecovery(protectedOperation, {
  cancel: {
    operation: cancelOperation,
    map: (attempt) => ({
      attemptRef: attempt.ref,
      primaryIdempotencyKey: attempt.idempotencyKey,
    }),
    idempotencyKey: (attempt) => `cancel:${attempt.idempotencyKey}`,
  },
});

async function exerciseSmallerSurface(ctx: WorkflowCtx): Promise<void> {
  const protectedResult = await ctx.operation(
    protectedOperation,
    { id: "candidate" },
    {
      key: "protected-operation",
      authorization: { detail: "Authorize the frozen input" },
    },
  );
  protectedResult.accepted;

  const recoverableResult = await ctx.operation(
    recoverableOperation,
    { id: "candidate" },
    {
      key: "recoverable-operation",
      idempotencyKey: "candidate",
      authorization: { detail: "Authorize the recoverable input" },
    },
  );
  if (recoverableResult.status === "succeeded") recoverableResult.receipt.output.accepted;

  await ctx.step("group", async (step) => {
    await step.sleep("1s", { key: "wait" });
  });

  await ctx.parallel.all(
    ["a", "b"],
    async (item, lane) => {
      await lane.sleep("1s", { key: lane.key("wait") });
      return item;
    },
    { key: "parallel", keyOf: (item) => item },
  );

  // @ts-expect-error Protected behavior is selected by the definition, not a method name.
  ctx.operation.run;
  // @ts-expect-error Recoverable behavior is selected by the definition, not a method name.
  ctx.operation.runRecoverable;
  // @ts-expect-error Explicit lifecycle stages are internal to the engine.
  ctx.operation.prepare;
  // @ts-expect-error Delivery is one callable capability.
  ctx.delivery.run;
  // @ts-expect-error Same-run reuse is an ordinary typed function.
  ctx.recipe;
  // @ts-expect-error Sequential traversal uses a bounded TypeScript loop and keyed steps.
  ctx.sequence;
  // @ts-expect-error Multi-stage collection transforms use TypeScript plus parallel fan-out.
  ctx.pipeline;
  // @ts-expect-error Settled arrays are handled with ordinary discriminated-union code.
  ctx.successes;
  // @ts-expect-error Settled arrays are handled with ordinary discriminated-union code.
  ctx.all;
  // @ts-expect-error Durable grouping always owns a callback.
  ctx.step("missing-callback");
  // @ts-expect-error Policy decisions replaced the deprecated gate alias.
  ctx.gate;
  // @ts-expect-error Human branching uses confirm.
  ctx.human.approve;
  // @ts-expect-error Check waivers use the explicit authorizeWaiver name.
  ctx.check.authorize;
  // @ts-expect-error Durable workspace leases are not part of ordinary authoring.
  ctx.workspace.lease;
  // @ts-expect-error Reusable observers replace low-level poll helpers.
  ctx.poll;
  // @ts-expect-error Reusable observers replace low-level signal helpers.
  ctx.signal;
  // @ts-expect-error Exec is the single process primitive.
  ctx.bash;
}

function exerciseWorkspaceSurface(ctx: WorkspaceCtx): void {
  ctx.workspace.snapshot;
  // @ts-expect-error Candidate freshness is enforced inside candidate-bound host calls.
  ctx.workspace.assertUnchanged;
  // @ts-expect-error Snapshot comparison is an engine responsibility.
  ctx.workspace.sameSnapshot;
}

void exerciseSmallerSurface;
void exerciseWorkspaceSurface;
