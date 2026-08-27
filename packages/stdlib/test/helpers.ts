/**
 * A real Engine over memory stores, driven by the mock provider registered as both
 * "claude" and "codex". Patterns are exercised end to end — every step goes through
 * the scheduler, the journal, and real schema validation.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  type JournalRecord,
  MemoryBlobStore,
  MemoryJournalStore,
  ProviderRegistry,
} from "@techery/weft-core";
import { type MockAgentBuilder, mock } from "@techery/weft-provider-mock";
import type { WorkflowDefinition } from "@techery/weft-sdk";

export interface Harness {
  engine: Engine;
  journal: MemoryJournalStore;
  blobs: MemoryBlobStore;
  builder: MockAgentBuilder;
}

export function harness(builder: MockAgentBuilder = mock()): Harness {
  const journal = new MemoryJournalStore();
  const blobs = new MemoryBlobStore();
  const providers = new ProviderRegistry();
  providers.register(builder.provider("claude"));
  providers.register(builder.provider("codex"));
  const engine = new Engine({ journal, blobs, providers, config: {} });
  return { engine, journal, blobs, builder };
}

const tempDirs: string[] = [];

export async function tempCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "weft-stdlib-"));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupCwds(): Promise<void> {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((d) =>
        rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined),
      ),
  );
}

export interface RunResult<Out> {
  runId: string;
  output: Out;
  records: JournalRecord[];
}

/** Start a workflow, wait for its validated output, and hand back the journal too. */
export async function runWorkflow<In, Out, RawIn = In>(
  h: Harness,
  def: WorkflowDefinition<In, Out, unknown, RawIn>,
  input: RawIn,
): Promise<RunResult<Out>> {
  const handle = await h.engine.start(def, { input, cwd: await tempCwd() });
  const output = (await handle.result) as Out;
  const records: JournalRecord[] = [];
  for await (const rec of h.journal.read(handle.runId)) records.push(rec);
  return { runId: handle.runId, output, records };
}

/** Every `ctx.log` message a run emitted, in order. */
export function logs(records: JournalRecord[]): string[] {
  return records.flatMap((r) => (r.ev.type === "log" ? [r.ev.message] : []));
}

/** Every branch `ctx.successes()` dropped, as `code: message` reasons. */
export function drops(records: JournalRecord[]): string[] {
  return records.flatMap((r) => (r.ev.type === "drop" ? [r.ev.reason] : []));
}
