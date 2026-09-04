import type { ReviewParallelLaneContext } from "../core/composition.ts";
import type { ReviewCtx } from "../core/workflow.ts";
import {
  defineCheck,
  defineDelivery,
  defineOperation,
  defineProcedure,
  type WorkflowCtx,
  type WorkspaceCtx,
  type WorkspaceSnapshotRef,
  withRecovery,
  z,
} from "../index.ts";

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

const deliveryCheck = defineCheck({
  name: "type-test-delivery-check",
  revision: "v1",
  command: ["true"],
  policy: "required",
  waiver: { mode: "never" },
});

const delivery = defineDelivery({
  name: "type-test-delivery",
  binding: "type-test.delivery",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ url: z.string().url() }).strict(),
  capabilities: ["network"],
  defaults: {
    authorization: {
      action: "Publish the type-test candidate",
      risk: "high",
    },
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

  ctx.scope({ budget: { tokens: 100 } });

  await ctx.parallel.all(
    ["a", "b"],
    async (item, lane) => {
      await lane.sleep("1s", { key: "wait" });
      // @ts-expect-error Lane calls use local keys directly; authors do not assemble resolved keys.
      lane.key;
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
  // @ts-expect-error Workflow structure uses TypeScript rather than a durable grouping callback.
  ctx.step;
  // @ts-expect-error Scope changes inherited defaults and does not organize durable keys.
  ctx.scope({ keyPrefix: "group" });
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

async function exerciseWorkspaceSurface(ctx: WorkspaceCtx): Promise<void> {
  const candidate = ctx.workspace.snapshot;
  const checked = await ctx.check(deliveryCheck, { key: "delivery-check", candidate });
  if (checked.status === "pass" && checked.disposition === "executed") {
    await ctx.delivery(
      delivery,
      { id: "candidate" },
      {
        key: "delivery",
        candidate,
        proofs: [checked.proof],
        authorization: { detail: "Publish the checked candidate" },
      },
    );

    // @ts-expect-error Delivery input is the second argument, not a field inside execution options.
    await ctx.delivery(delivery, {
      key: "legacy-delivery",
      candidate,
      input: { id: "candidate" },
      proofs: [checked.proof],
      authorization: { detail: "Legacy request shape" },
    });
  }
  // @ts-expect-error Candidate freshness is enforced inside candidate-bound host calls.
  ctx.workspace.assertUnchanged;
  // @ts-expect-error Snapshot comparison is an engine responsibility.
  ctx.workspace.sameSnapshot;
}

declare const candidateAIdentity: unique symbol;
declare const candidateBIdentity: unique symbol;
declare const candidateA: WorkspaceSnapshotRef & { readonly [candidateAIdentity]: true };
declare const candidateB: WorkspaceSnapshotRef & { readonly [candidateBIdentity]: true };

async function exerciseCandidateCorrelation(ctx: WorkspaceCtx): Promise<void> {
  const checked = await ctx.check(deliveryCheck, { key: "candidate-a-check", candidate: candidateA });
  if (checked.status === "pass" && checked.disposition === "executed") {
    await ctx.delivery(
      delivery,
      { id: "candidate-b" },
      {
        key: "mismatched-delivery",
        candidate: candidateB,
        // @ts-expect-error Positive proof for candidate A cannot promote candidate B.
        proofs: [checked.proof],
        authorization: { detail: "Reject mixed candidates" },
      },
    );
  }
}

/** Declares exactly the capabilities the body reads, so the requirement stays a whitelist. */
const collectRepositoryFacts = defineProcedure({
  name: "collect-repository-facts",
  description: "Read head and the dependency tree",
  revision: "v1",
  input: z.object({ baseRef: z.string().min(1) }).strict(),
  output: z.object({ head: z.string().min(1), files: z.array(z.string()) }).strict(),
  run: async (ctx: Pick<WorkflowCtx, "git" | "exec">, input) => {
    // Durable keys inside a procedure body are local to one invocation.
    const head = await ctx.git.head({ key: "head" });
    const changed = await ctx.git.changedSince(input.baseRef, { key: "changed" });
    await ctx.exec("npm", ["ls", "--json"], { key: "dependencies" });
    return { head: head.sha, files: changed.files.map(({ path }) => path) };
  },
});

/** A procedure that mutates the workspace cannot be invoked from a read-only workflow context. */
const commitRemediation = defineProcedure({
  name: "commit-remediation",
  revision: "v1",
  input: z.object({ message: z.string().min(1) }).strict(),
  output: z.object({ sha: z.string().min(1) }).strict(),
  run: async (ctx: Pick<WorkspaceCtx, "git">, input) => {
    const committed = await ctx.git.commit({ key: "commit", message: input.message });
    return { sha: committed.sha };
  },
});

async function exerciseProcedureSurface(ctx: WorkflowCtx, workspaceCtx: WorkspaceCtx): Promise<void> {
  const facts = await ctx.procedure(
    collectRepositoryFacts,
    { baseRef: "main" },
    { key: "collect", label: "Collect repository facts" },
  );
  expectString(facts.head);
  expectString(facts.files[0] ?? "");

  const receipt = await ctx.procedure.detailed(
    collectRepositoryFacts,
    { baseRef: "main" },
    { key: "collect-detailed" },
  );
  expectBoolean(receipt.replayed);
  expectString(receipt.inputDigest);

  // A workspace context supplies strictly more, so the read-only body remains callable.
  await workspaceCtx.procedure(collectRepositoryFacts, { baseRef: "main" }, { key: "collect-in-workspace" });
  await workspaceCtx.procedure(commitRemediation, { message: "fix: patch" }, { key: "commit" });

  // @ts-expect-error A read-only workflow context cannot satisfy a body that requires workspace mutation.
  await ctx.procedure(commitRemediation, { message: "fix: patch" }, { key: "commit" });

  // @ts-expect-error Procedure input is the second argument, matching every other definition-backed call.
  await ctx.procedure(collectRepositoryFacts, { key: "inline-input", input: { baseRef: "main" } });

  // @ts-expect-error Procedure input is schema-validated rather than structurally loose.
  await ctx.procedure(collectRepositoryFacts, { baseRef: 1 }, { key: "wrong-input" });

  // @ts-expect-error Invocations never restate the body's declared revision.
  await ctx.procedure(collectRepositoryFacts, { baseRef: "main" }, { key: "k", revision: "v2" });
}

function expectString(_value: string): void {}
function expectBoolean(_value: boolean): void {}

void exerciseSmallerSurface;
void exerciseWorkspaceSurface;
void exerciseCandidateCorrelation;
void exerciseProcedureSurface;

type AssertNever<Value extends never> = Value;
type AssertTrue<Value extends true> = Value;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

/** Review lanes retain every review capability. */
export type ReviewLaneMissingCapabilities = AssertNever<
  Exclude<keyof ReviewCtx, keyof ReviewParallelLaneContext>
>;

/** Review lanes add identity, never authority. */
export type ReviewLaneUnexpectedCapabilities = AssertNever<
  Exclude<keyof ReviewParallelLaneContext, keyof ReviewCtx | "itemKey">
>;

/** Review lanes remain usable wherever an ordinary review context is expected. */
export type ReviewLaneIsReviewContext = AssertTrue<IsAssignable<ReviewParallelLaneContext, ReviewCtx>>;
