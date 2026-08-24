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
 */

export type {
  MockAgentBuilder,
  MockRequest,
  MockResponder,
  MockRuleOptions,
} from "@techery/weft-provider-mock";
export { mock } from "@techery/weft-provider-mock";
export type { StoreFixture } from "./conformance.ts";
export { blobStoreConformance, journalStoreConformance } from "./conformance.ts";
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
export type { AnswerFixtures, RunWorkflowOptions, RunWorkflowResult } from "./run.ts";
export { runWorkflow } from "./run.ts";
