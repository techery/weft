/**
 * The journal owns the diffs (C6): write steps edit their own git worktree, come
 * back as patches, and only ctx.integrate() lands them on the integration tree —
 * explicitly, in the order you pass, with scopes enforced.
 *
 *   npx tsx examples/03-write-steps-and-patches/main.ts
 *
 * Needs a real git repo, so this example builds a throwaway one. The "agents" are
 * mock fixtures whose `writes` land files in whatever worktree the engine hands
 * them — exactly where a real agent's Edit tool would write.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Engine, MemoryBlobStore, MemoryJournalStore, ProviderRegistry } from "@techery/weft-core";
import { mock } from "@techery/weft-provider-mock";
import { defineWorkflow, z } from "@techery/weft-sdk";

const execFile = promisify(execFileCb);

// -- a throwaway repo --------------------------------------------------------
const repo = await mkdtemp(join(tmpdir(), "weft-example-"));
const git = (...args: string[]) => execFile("git", args, { cwd: repo });
await git("init", "-b", "main");
await git("config", "user.email", "weft@example");
await git("config", "user.name", "weft");
await writeFile(join(repo, "auth.ts"), "export const auth = 'v1';\n");
await writeFile(join(repo, "api.ts"), "export const api = 'v1';\n");
await git("add", "-A");
await git("commit", "-m", "base");

// -- scripted "agents" -------------------------------------------------------
const FixResult = z.object({ summary: z.string() });
const builder = mock()
  .on(
    { key: "fix:auth" },
    { summary: "bounded the retry loop" },
    { writes: { "auth.ts": "export const auth = 'v2';\n" } },
  )
  // this one oversteps its scope: it also touches NOTES.md
  .on(
    { key: "fix:api" },
    { summary: "tightened pagination (and left a note)" },
    { writes: { "api.ts": "export const api = 'v2';\n", "NOTES.md": "TODO: split handlers\n" } },
  );

const fixPass = defineWorkflow(
  {
    name: "fix-pass",
    description: "Two scoped write steps, explicit integration, a scope violation flagged",
    input: z.object({}),
    output: z.object({ merged: z.array(z.string()), violations: z.number() }),
  },
  async (ctx) => {
    ctx.phase("Fix");
    const fixes = ctx.successes(
      await ctx.parallel([
        ctx.agent.detailed("Fix the retry loop in auth.ts and nothing else.", {
          schema: FixResult,
          key: "fix:auth",
          write: { paths: ["auth.ts"], mode: "warn" },
        }),
        ctx.agent.detailed("Fix pagination in api.ts.", {
          schema: FixResult,
          key: "fix:api",
          write: { paths: ["api.ts"], mode: "warn" }, // NOTES.md will be out of scope → flagged, still lands
        }),
      ]),
    );
    for (const fix of fixes) {
      ctx.log(
        `patch ${fix.patch!.key}: files=[${fix.patch!.files.join(", ")}] outOfScope=[${(fix.patch!.outOfScope ?? []).join(", ")}]`,
      );
    }

    ctx.phase("Integrate");
    // Until this line the integration tree is untouched — patches are blobs.
    const before = await ctx.fs.read("auth.ts");
    ctx.log(`pre-integrate auth.ts: ${before.content.trim()}`);
    const ledger = await ctx.integrate(fixes, { order: "sequential", onConflict: "fail" });

    return {
      merged: ledger.merged,
      violations: fixes.filter((f) => (f.patch?.outOfScope ?? []).length > 0).length,
    };
  },
);

const providers = new ProviderRegistry();
providers.register(builder.provider("claude"));
providers.register(builder.provider("codex"));
const engine = new Engine({ journal: new MemoryJournalStore(), blobs: new MemoryBlobStore(), providers });

const handle = await engine.start(fixPass, { input: {}, cwd: repo });
const output = await handle.result;
console.log("output:   ", output);
console.log("auth.ts:  ", (await readFile(join(repo, "auth.ts"), "utf8")).trim());
console.log("api.ts:   ", (await readFile(join(repo, "api.ts"), "utf8")).trim());
console.log(
  "NOTES.md: ",
  (await readFile(join(repo, "NOTES.md"), "utf8")).trim(),
  " (warn mode: flagged, landed)",
);

const report = await engine.report(handle.runId);
const risk = report.split("## Remaining risk")[1]?.split("##")[0]?.trim();
console.log(`\nreport → remaining risk:\n${risk ?? "(none)"}`);

await rm(repo, { recursive: true, force: true });
