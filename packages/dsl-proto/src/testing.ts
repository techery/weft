/** Declaration-only workflow test-harness contracts for the Weft DSL prototype. */

import type {
  AnyWorkflowDefinition,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowTypesOf,
  WorkflowWorkspaceModeOf,
} from "./core/workflow.ts";
import type { WorkflowCtx, WorkspaceCtx } from "./facade.ts";

type WorkflowTaskInputOf<Definition extends AnyWorkflowDefinition> =
  WorkflowTypesOf<Definition> extends { readonly taskInput: infer TaskInput } ? TaskInput : unknown;

type WorkflowTasksOf<Definition extends AnyWorkflowDefinition> =
  WorkflowTypesOf<Definition> extends { readonly tasks: infer Tasks } ? Tasks : unknown;

/**
 * Why: Selects the same named context view a workflow receives from its declared workspace mode.
 * Use: Build a typed fake host without reaching into a hidden workflow implementation callback.
 */
export type WorkflowTestContextOf<Definition extends AnyWorkflowDefinition> =
  WorkflowWorkspaceModeOf<Definition> extends true
    ? WorkspaceCtx<WorkflowTaskInputOf<Definition>, WorkflowTasksOf<Definition>>
    : WorkflowCtx<WorkflowTaskInputOf<Definition>, WorkflowTasksOf<Definition>>;

/**
 * Why: Names the engine-facing fake context required to exercise one exact workflow contract.
 * Use: Supply a host-owned test double whose capabilities match the workflow's workspace mode.
 */
export interface WorkflowTestHost<Definition extends AnyWorkflowDefinition> {
  readonly context: WorkflowTestContextOf<Definition>;
}

/**
 * Why: Exposes schema-validated workflow execution only after a test host has been bound explicitly.
 * Use: Call `run` with the workflow's raw input and assert its validated output.
 */
export interface BoundWorkflowTestHarness<Definition extends AnyWorkflowDefinition> {
  run(input: WorkflowInputOf<Definition>): Promise<WorkflowOutputOf<Definition>>;
}

/**
 * Why: Prevents tests from directly invoking hidden workflow callbacks or bypassing the host boundary.
 * Use: Bind a typed fake host, then run the workflow through the returned harness.
 */
export interface WorkflowTestHarness<Definition extends AnyWorkflowDefinition> {
  withContext(host: WorkflowTestHost<Definition>): BoundWorkflowTestHarness<Definition>;
}

/**
 * Why: Creates an explicit workflow testing boundary while keeping the definition itself inert.
 * Use: Call `testWorkflow(workflow).withContext(fakeHost).run(input)` in future engine-backed tests.
 */
export declare function testWorkflow<Definition extends AnyWorkflowDefinition>(
  definition: Definition,
): WorkflowTestHarness<Definition>;
