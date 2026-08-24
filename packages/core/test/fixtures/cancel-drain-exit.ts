/**
 * Run by `cancel-drain-exit.test.ts` as its OWN process. Not a test file — what it
 * measures is what Node does with the event loop, and a test runner always has one.
 *
 * `weft cancel <run>` is a one-shot process: it starts an engine, asks a wedged run to
 * stop, and has nothing else to do. `cancel()` bounds that wait so a step which ignores
 * its abort cannot hang the caller forever — past the bound the run is fenced, journaled
 * cancelled, and retired.
 *
 * A step gets that for free: its own timeout timer is referenced and outlives a hung
 * provider. The workflow BODY does not. A body that awaits something never-settling
 * outside any step — a bare promise, a wedged library call, a listener that never fires —
 * leaves the drain timer as the only thing standing between this process and exit, and
 * Node does not wait on an unreferenced timer. The process would then exit silently,
 * before the timeout branch journals `run.cancelled`: the bounded guarantee lost in
 * exactly the case it was written for. The exit code and the missing STATUS line are how
 * the test sees it.
 */
import { Engine, MemoryBlobStore, MemoryJournalStore, ProviderRegistry } from "@techery/weft-core";
import { defineWorkflow, z } from "@techery/weft-sdk";

const engine = new Engine({
  journal: new MemoryJournalStore(),
  blobs: new MemoryBlobStore(),
  providers: new ProviderRegistry(),
  config: {},
});

const def = defineWorkflow(
  { name: "wedged", description: "wedged", input: z.object({}), output: z.object({ v: z.number() }) },
  // No step, no timers, no handles: the body simply never returns and never looks at
  // its abort signal.
  async () => new Promise<never>(() => undefined),
);

const handle = await engine.start(def, { input: {}, cwd: process.cwd() });
handle.result.catch(() => undefined);
// Let the body get going. This timer is the harness's own and is referenced; once it
// fires, nothing in this process holds the loop but cancel()'s drain.
await new Promise((resolve) => setTimeout(resolve, 50));

await engine.cancel(handle.runId);
const state = await engine.state(handle.runId);
process.stdout.write(`STATUS=${state.status}\n`);
