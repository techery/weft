import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Engine,
  type EngineConfigInput,
  MemoryBlobStore,
  MemoryJournalStore,
  ProviderRegistry,
  type WorkflowRegistry,
} from "@techery/weft-core";
import { type MockAgentBuilder, mock } from "@techery/weft-provider-mock";
import { execa } from "execa";

export interface TestEngine {
  engine: Engine;
  journal: MemoryJournalStore;
  blobs: MemoryBlobStore;
  builder: MockAgentBuilder;
}

/**
 * Engine over memory stores with the mock provider registered as both "claude"
 * and "codex" (one shared rule set + call log).
 */
export function testEngine(
  opts: { config?: EngineConfigInput; registry?: WorkflowRegistry; builder?: MockAgentBuilder } = {},
): TestEngine {
  const journal = new MemoryJournalStore();
  const blobs = new MemoryBlobStore();
  const builder = opts.builder ?? mock();
  const providers = new ProviderRegistry();
  providers.register(builder.provider("claude"));
  providers.register(builder.provider("codex"));
  const engine = new Engine({
    journal,
    blobs,
    providers,
    config: opts.config ?? {},
    ...(opts.registry ? { registry: opts.registry } : {}),
  });
  return { engine, journal, blobs, builder };
}

/** Fresh engine over the SAME stores — simulates a new process for resume tests. */
export function reopen(
  prev: TestEngine,
  opts: {
    config?: EngineConfigInput;
    registry?: WorkflowRegistry;
    builder?: MockAgentBuilder;
    /** Stand in for a blob store whose files did not survive (a pruned cache, a partial restore). */
    blobs?: MemoryBlobStore;
  } = {},
): TestEngine {
  const builder = opts.builder ?? mock();
  const blobs = opts.blobs ?? prev.blobs;
  const providers = new ProviderRegistry();
  providers.register(builder.provider("claude"));
  providers.register(builder.provider("codex"));
  const engine = new Engine({
    journal: prev.journal,
    blobs,
    providers,
    config: opts.config ?? {},
    ...(opts.registry ? { registry: opts.registry } : {}),
  });
  return { engine, journal: prev.journal, blobs, builder };
}

const cleanups: Array<() => Promise<void>> = [];

/** Temp git repo with an initial commit; cleaned up via cleanupRepos(). */
export async function tempRepo(files: Record<string, string> = { "README.md": "hello\n" }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "weft-core-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const git = (...args: string[]) => execa("git", args, { cwd: dir });
  await git("init", "-b", "main");
  await git("config", "user.email", "weft@test");
  await git("config", "user.name", "weft");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await git("add", "-A");
  await git("commit", "-m", "init");
  return dir;
}

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "weft-dir-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

export async function cleanupRepos(): Promise<void> {
  await Promise.all(cleanups.splice(0).map((fn) => fn().catch(() => undefined)));
}
