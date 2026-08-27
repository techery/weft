/**
 * @techery/weft-testing — the workflow test harness.
 *
 * ```ts
 * import { runWorkflow, mock } from "@techery/weft-testing";
 *
 * const { output, journal } = await runWorkflow(review, {
 *   input: { base: "main" },
 *   provider: mock().on({ key: "review:*" }, () => ({ findings: [] })),
 *   git: { changedSince: { files: [{ path: "a.ts", status: "M" }] } },
 * });
 * ```
 *
 * Fixtures go through the engine's normal validation and journaling: a fixture
 * that would not pass in production fails the test.
 *
 * The store conformance suites live at `@techery/weft-testing/conformance`. They are the
 * only thing here that imports `vitest`, and importing them from this entry point made
 * `vitest` a hard runtime requirement of `runWorkflow` — unresolvable from a published
 * install, where it is the consumer's dependency and not this package's.
 */

export type {
  MockAgentBuilder,
  MockRequest,
  MockResponder,
  MockRuleOptions,
  MockTaskEnvelope,
} from "@techery/weft-provider-mock";
export { mock, mockTaskEnvelope } from "@techery/weft-provider-mock";
export type {
  BashFixtures,
  ExecFixtures,
  FetchFixtures,
  FixtureOptions,
  GitFixture,
  GitFixtures,
} from "./fixtures.ts";
export { buildTestHooks } from "./fixtures.ts";
export type { JournalSnapshotEntry, JournalView, StepStatus, StepView } from "./journal.ts";
export { buildJournalView } from "./journal.ts";
export type {
  AnswerFixtures,
  RunWorkflowOptions,
  RunWorkflowResult,
  SignalFixtures,
  TaskSeed,
} from "./run.ts";
export { runWorkflow } from "./run.ts";
