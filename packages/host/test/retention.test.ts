import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test } from "vitest";
import {
  createWeft,
  loadWorkflow,
  persistedDefOf,
  persistRetainedWorkflow,
  persistWorkflowRef,
  type RetainedWorkflow,
  reserveRunId,
  resolveWorkflow,
  resumeOptions,
  retainedDefOf,
  type Weft,
} from "../src/index.ts";
import { cleanupRoots, tempRoot, write } from "./helpers.ts";

const opened: Weft[] = [];
afterAll(async () => {
  await Promise.all(opened.map((weft) => weft.close()));
  await cleanupRoots();
});

async function host(cwd: string, allowBare?: string[]): Promise<Weft> {
  const weft = await createWeft({
    cwd,
    providers: "mock",
    ...(allowBare ? { config: { workflows: { allowBare } } } : {}),
  });
  opened.push(weft);
  return weft;
}

const source = `import { defineWorkflow, z } from "@techery/weft-sdk";
import { value } from "./lib/value.ts";
export default defineWorkflow({ description: "original workflow", input: z.object({}), output: z.string() }, async ctx => {
  await ctx.human.approve({ action: "continue?" });
  return value;
});`;

function retainable(resolved: Awaited<ReturnType<typeof resolveWorkflow>>): RetainedWorkflow {
  if (!resolved.hash) throw new Error("missing executable hash");
  return { ...resolved, hash: resolved.hash };
}

test("retained registry resume restores original name, relative modules, and future UI after source removal", async () => {
  const root = await tempRoot();
  const entry = ".weft/workflows/retained/main.ts";
  await write(
    root,
    entry,
    source
      .replace("import { value }", 'import view from "./summary.ui.tsx";\nimport { value }')
      .replace(
        "return value;",
        'await ctx.ui.render({ key: "summary", view, props: { value } }); return value;',
      ),
  );
  await write(root, ".weft/workflows/retained/lib/value.ts", 'export const value = "original";');
  await write(
    root,
    ".weft/workflows/retained/summary.ui.tsx",
    `import { defineResultView } from "@techery/weft-sdk/ui";
export default defineResultView<{value:string}>({ id: "retained-summary", revision: "1", component: ({props}) => <div>{props.value}</div> });`,
  );
  const original = await host(root);
  const resolved = await resolveWorkflow(original, "retained");
  expect((await original.registry.load("retained")).code).toBe(resolved.code);
  expect(resolved.uiCatalog?.assets).toHaveLength(1);
  const runId = await reserveRunId(original);
  await persistRetainedWorkflow(original, runId, retainable(resolved));
  const run = await original.engine.start(resolved.def, {
    runId,
    input: {},
    cwd: root,
    defHash: resolved.hash,
    uiCatalog: resolved.uiCatalog,
  });
  expect((await run.outcome()).status).toBe("waiting_for_human");
  await original.close();
  await rm(join(root, ".weft/workflows/retained"), { recursive: true });
  const reopened = await host(root);
  // Retention does not silently change default registry semantics or impersonate inline source.
  expect(await persistedDefOf(reopened, runId)).toBeUndefined();
  expect(existsSync(join(reopened.runsDir, runId, "script.ts"))).toBe(false);
  expect(existsSync(join(reopened.runsDir, runId, "workflow.json"))).toBe(false);
  const retained = await retainedDefOf(reopened, runId);
  expect(retained?.def.meta.name).toBe("retained");
  expect(retained?.hash).toBe(resolved.hash);
  expect(retained?.uiCatalog).toEqual(resolved.uiCatalog);
  const resumed = await reopened.engine.resume(runId, { ...resumeOptions(retained), mode: "strict" });
  const outcome = await resumed.outcome();
  if (outcome.status !== "waiting_for_human") throw new Error("expected human suspension");
  await reopened.engine.answer(runId, outcome.pending[0]!.id, { approved: true });
  expect(await resumed.result).toBe("original");
});

test("retained path source stays original while ordinary path resume sees current edits", async () => {
  const root = await tempRoot();
  await write(root, "flows/review.ts", source);
  await write(root, "flows/lib/value.ts", 'export const value = "original";');
  const weft = await host(root);
  const resolved = await resolveWorkflow(weft, "./flows/review.ts");
  const runId = await reserveRunId(weft);
  await persistRetainedWorkflow(weft, runId, retainable(resolved));
  await persistWorkflowRef(weft, runId, "./flows/review.ts");
  await write(root, "flows/review.ts", source.replace("original workflow", "edited workflow"));
  await write(root, "flows/lib/value.ts", 'export const value = "changed";');
  const retained = await retainedDefOf(weft, runId);
  const current = await persistedDefOf(weft, runId);
  expect(retained?.def.meta.description).toBe("original workflow");
  expect(retained?.def.meta.name).toBe("review");
  expect(retained?.hash).toBe(resolved.hash);
  expect(current?.def.meta.description).toBe("edited workflow");
  expect(current?.hash).not.toBe(resolved.hash);
});

test("retained resume refuses external helper drift without workflow source or package version changes", async () => {
  const root = await tempRoot();
  await write(
    root,
    "external/package.json",
    JSON.stringify({ name: "retained-external-fixture", version: "1.0.0", type: "module" }),
  );
  await write(root, "external/entry.js", 'export { value } from "./helper.js";');
  await write(root, "external/helper.js", 'export const value = "original";');
  const external = pathToFileURL(join(root, "external/entry.js")).href;
  const weft = await host(root, [external]);
  const loaded = await loadWorkflow({
    source: source.replace('"./lib/value.ts"', JSON.stringify(external)),
    cwd: root,
    allowBare: [external],
  });
  const runId = await reserveRunId(weft);
  await persistRetainedWorkflow(weft, runId, loaded);
  expect((await retainedDefOf(weft, runId))?.hash).toBe(loaded.hash);
  await write(root, "external/helper.js", 'export const value = "changed";');
  await expect(retainedDefOf(weft, runId)).rejects.toMatchObject({
    code: "recovery_required",
    message: expect.stringMatching(/changed external dependencies/),
  });
  await expect(persistRetainedWorkflow(weft, "changed-before-start", loaded)).rejects.toThrow(
    /dependencies changed before provenance/,
  );
});

test("retained provenance is idempotent but immutable, and only absence permits fallback", async () => {
  const root = await tempRoot();
  const weft = await host(root);
  const loaded = await loadWorkflow({
    source: `import {defineWorkflow,z} from "@techery/weft-sdk"; export default defineWorkflow({description:"fixture",input:z.object({}),output:z.string()}, async () => "ok");`,
    cwd: root,
  });
  const runId = await reserveRunId(weft);
  await persistRetainedWorkflow(weft, runId, loaded);
  await persistRetainedWorkflow(weft, runId, loaded);
  await expect(persistRetainedWorkflow(weft, runId, { ...loaded, name: "replacement" })).rejects.toThrow(
    /refusing to replace/,
  );
  expect(await retainedDefOf(weft, "old-history-no-manifest")).toBeUndefined();
  const file = join(weft.runsDir, runId, "retained-workflow.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as { bundleRef: string };
  const blobFile = join(weft.weftDir, "blobs", manifest.bundleRef.slice(0, 2), manifest.bundleRef);
  await writeFile(blobFile, "corrupt");
  await expect(retainedDefOf(weft, runId)).rejects.toThrow(/corrupt/i);
  await writeFile(file, JSON.stringify({ format: 2 }));
  await expect(retainedDefOf(weft, runId)).rejects.toThrow(/invalid retained workflow provenance/);
  await expect(retainedDefOf(weft, "../escape")).rejects.toMatchObject({ code: "invalid_input" });
});
