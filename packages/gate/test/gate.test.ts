import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Ctx, isZodSchema, validateSchema } from "@techery/weft-sdk";
import { afterAll, describe, expect, it } from "vitest";
import {
  bundleWorkflow,
  checkSource,
  createWorkflowRegistry,
  formatDiagnostics,
  GateError,
  loadWorkflow,
} from "../src/index.ts";
import { instantiateBundle } from "../src/load.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "weft-gate-"));
  roots.push(dir);
  return dir;
}

async function write(dir: string, file: string, source: string): Promise<string> {
  const target = path.join(dir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");
  return target;
}

afterAll(async () => {
  await Promise.all(
    roots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

/** Expected position of `needle`, so tests never hand-count lines and columns. */
function locate(lines: string[], needle: string): { line: number; column: number } {
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`fixture does not contain ${needle}`);
  return { line: index + 1, column: (lines[index] as string).indexOf(needle) + 1 };
}

function positionOf(diagnostic: { line: number; column: number }): { line: number; column: number } {
  return { line: diagnostic.line, column: diagnostic.column };
}

const SCHEMAS = [
  `import { z } from "@techery/weft-sdk";`,
  ``,
  `export const Finding = z.object({ file: z.string(), note: z.string() });`,
  ``,
].join("\n");

/** A clean workflow: relative import, everything time-like routed through ctx. */
function reviewSource(
  opts: { id?: string; name?: string; description?: string; note?: string } = {},
): string {
  const meta = [
    opts.id ? `    id: "${opts.id}",` : "",
    opts.name ? `    name: "${opts.name}",` : "",
    `    description: "${opts.description ?? "Review a target and report findings"}",`,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    `import { defineWorkflow, z } from "@techery/weft-sdk";`,
    `import { Finding } from "./schemas.ts";`,
    ``,
    `export default defineWorkflow(`,
    `  {`,
    meta,
    `    input: z.object({ target: z.string() }),`,
    `    output: z.object({ findings: z.array(Finding), at: z.number() }),`,
    `  },`,
    `  async (ctx, input) => {`,
    `    const at = await ctx.now();`,
    `    return { findings: [{ file: input.target, note: "${opts.note ?? "looks fine"}" }], at };`,
    `  },`,
    `);`,
    ``,
  ].join("\n");
}

async function writeReview(
  dir: string,
  file = "review.ts",
  opts: Parameters<typeof reviewSource>[0] = {},
): Promise<string> {
  await write(dir, "schemas.ts", SCHEMAS);
  return write(dir, file, reviewSource(opts));
}

/** A minimal workflow body that runs `body` at module top level or inside run(). */
function sandboxProbe(opts: { top?: string; body?: string }): string {
  return [
    `import { defineWorkflow, z } from "@techery/weft-sdk";`,
    ``,
    opts.top ?? ``,
    ``,
    `export default defineWorkflow(`,
    `  { description: "probe", input: z.object({}), output: z.object({ ok: z.boolean() }) },`,
    `  async (ctx, input) => {`,
    `    ${opts.body ?? ""}`,
    `    return { ok: true };`,
    `  },`,
    `);`,
    ``,
  ].join("\n");
}

const stubCtx = {
  now: async () => 1_700_000_000_000,
  random: async () => 0.25,
  log: () => {},
} as unknown as Ctx;

// ---------------------------------------------------------------------------
// checkSource
// ---------------------------------------------------------------------------

describe("checkSource", () => {
  it("passes clean workflow source", () => {
    expect(checkSource(reviewSource(), "review.ts")).toEqual([]);
  });

  it("passes the ctx replacements and non-global lookalikes", () => {
    const source = [
      `import { defineWorkflow } from "@techery/weft-sdk";`,
      `import { Finding } from "./schemas";`,
      `import type { Ctx } from "@techery/weft-sdk";`,
      `export async function helper(ctx: Ctx) {`,
      `  const at = await ctx.now();`,
      `  const r = await ctx.random();`,
      `  const res = await ctx.fetch("https://example.com");`,
      `  const seen = new Date(at);`,
      `  const parsed = Date.parse("2026-01-01");`,
      `  const max = Math.max(1, 2);`,
      `  await ctx.sleep("10m");`,
      `  return { at, r, res, seen, parsed, max, Finding, defineWorkflow };`,
      `}`,
    ].join("\n");
    expect(checkSource(source, "helper.ts")).toEqual([]);
  });

  it("flags Date.now()", () => {
    const lines = [`export function stamp() {`, `  return Date.now();`, `}`];
    const [d, ...rest] = checkSource(lines.join("\n"), "stamp.ts");
    expect(rest).toEqual([]);
    expect(d?.rule).toBe("no-date-now");
    expect(positionOf(d as { line: number; column: number })).toEqual(locate(lines, "Date.now"));
    expect(d?.file).toBe("stamp.ts");
    expect(d?.fixIt).toBe("Date.now() is unavailable - use ctx.now()");
  });

  it("flags Date['now'] too", () => {
    const [d] = checkSource(`const f = Date["now"];`, "f.ts");
    expect(d?.rule).toBe("no-date-now");
  });

  it("flags WeakRef and FinalizationRegistry (GC timing is not deterministic)", () => {
    const rules = checkSource(
      [`const r = new WeakRef({});`, `const reg = new FinalizationRegistry(() => {});`].join("\n"),
      "gc.ts",
    ).map((d) => d.rule);
    expect(rules).toEqual(["no-gc-globals", "no-gc-globals"]);
  });

  it("does not flag a workflow's own binding named WeakRef", () => {
    expect(checkSource(`const WeakRef = 1; export const x = { WeakRef: 2 };`, "own.ts")).toEqual([]);
  });

  it("flags locale-sensitive formatting and collation", () => {
    const rules = checkSource(
      [
        `const a = (1000.5).toLocaleString("de-DE");`,
        `const b = ["a", "b"].sort((x, y) => x.localeCompare(y));`,
        `const c = d.toLocaleDateString();`,
      ].join("\n"),
      "locale.ts",
    ).map((d) => d.rule);
    expect(rules).toEqual(["no-locale", "no-locale", "no-locale"]);
  });

  it("flags Intl, including through computed access", () => {
    const rules = checkSource(
      [`const f = new Intl.DateTimeFormat();`, `const g = Intl["NumberFormat"];`].join("\n"),
      "intl.ts",
    ).map((d) => d.rule);
    expect(rules).toEqual(["no-intl", "no-intl"]);
  });

  it("flags argless new Date() but not new Date(value)", () => {
    const lines = [
      `const ok = new Date(1234);`,
      `const alsoOk = new Date(input.iso);`,
      `const bad = new Date();`,
    ];
    const [d, ...rest] = checkSource(lines.join("\n"), "d.ts");
    expect(rest).toEqual([]);
    expect(d?.rule).toBe("no-argless-date");
    expect(positionOf(d as { line: number; column: number })).toEqual(locate(lines, "new Date();"));
    expect(d?.fixIt).toContain("use ctx.now()");
  });

  it("flags Math.random", () => {
    const lines = [`const pick = () => {`, `  return Math.random() > 0.5;`, `};`];
    const [d, ...rest] = checkSource(lines.join("\n"), "pick.ts");
    expect(rest).toEqual([]);
    expect(d?.rule).toBe("no-math-random");
    expect(positionOf(d as { line: number; column: number })).toEqual(locate(lines, "Math.random"));
    expect(d?.fixIt).toContain("ctx.random()");
  });

  it("flags every timer", () => {
    const lines = [`setTimeout(() => {}, 10);`, `setInterval(() => {}, 10);`, `setImmediate(() => {});`];
    const diagnostics = checkSource(lines.join("\n"), "t.ts");
    expect(diagnostics.map((d) => d.rule)).toEqual(["no-timers", "no-timers", "no-timers"]);
    expect(diagnostics.map((d) => d.line)).toEqual([1, 2, 3]);
    expect(diagnostics[0]?.message).toContain("setTimeout()");
    expect(diagnostics[1]?.message).toContain("setInterval()");
    expect(diagnostics[2]?.message).toContain("setImmediate()");
    expect(diagnostics[0]?.fixIt).toContain("ctx.sleep");
  });

  it("flags global fetch but not ctx.fetch", () => {
    const lines = [
      `export async function grab(ctx) {`,
      `  await ctx.fetch("https://a.example");`,
      `  return fetch("https://b.example");`,
      `}`,
    ];
    const [d, ...rest] = checkSource(lines.join("\n"), "grab.ts");
    expect(rest).toEqual([]);
    expect(d?.rule).toBe("no-global-fetch");
    expect(positionOf(d as { line: number; column: number })).toEqual(
      locate(lines, `fetch("https://b.example")`),
    );
    expect(d?.fixIt).toContain("ctx.fetch");
  });

  it("flags process.env in either access form", () => {
    const lines = [`const a = process.env.TOKEN;`, `const b = process["env"].OTHER;`];
    const diagnostics = checkSource(lines.join("\n"), "env.ts");
    expect(diagnostics.map((d) => d.rule)).toEqual(["no-process-env", "no-process-env"]);
    expect(positionOf(diagnostics[0] as { line: number; column: number })).toEqual(
      locate(lines, "process.env"),
    );
    expect(diagnostics[0]?.fixIt).toBe("process.env is unavailable - use ctx.env.get() / ctx.secret()");
  });

  it("flags require()", () => {
    const lines = [`const fs = require("node:fs");`];
    const [d] = checkSource(lines.join("\n"), "r.ts");
    expect(d?.rule).toBe("no-require");
    expect(positionOf(d as { line: number; column: number })).toEqual(locate(lines, `require(`));
    expect(d?.fixIt).toContain("relative import");
  });

  it("flags bare and node imports, allowing the allow-list and relatives", () => {
    const lines = [
      `import { defineWorkflow, z } from "@techery/weft-sdk";`,
      `import { z as z2 } from "zod";`,
      `import { thing } from "zod/v4";`,
      `import { Finding } from "./schemas.ts";`,
      `import { helper } from "../lib/helper.ts";`,
      `import fs from "node:fs";`,
      `import pathish from "path";`,
      `import lodash from "lodash";`,
      `export { Finding } from "./schemas.ts";`,
      `export * from "chalk";`,
    ];
    const diagnostics = checkSource(lines.join("\n"), "imports.ts");
    expect(diagnostics.map((d) => d.rule)).toEqual(Array(4).fill("no-bare-import"));
    expect(diagnostics.map((d) => d.line)).toEqual([6, 7, 8, 10]);
    expect(diagnostics[0]?.message).toContain('node builtin "node:fs"');
    expect(diagnostics[1]?.message).toContain('node builtin "path"');
    expect(diagnostics[2]?.message).toContain('bare import "lodash"');
    expect(diagnostics[3]?.message).toContain('bare import "chalk"');
    expect(diagnostics[0]?.fixIt).toBe(
      "bare imports are not allowed in workflow code - relative imports are bundled; put helpers in ./lib",
    );
    expect(positionOf(diagnostics[0] as { line: number; column: number })).toEqual(
      locate(lines, `import fs from`),
    );
  });

  it("flags dynamic imports of bare packages, not of relatives", () => {
    const lines = [
      `const a = await import("./lib/helper.ts");`,
      `const b = await import("lodash");`,
      `const c = await import(name);`,
    ];
    const diagnostics = checkSource(lines.join("\n"), "dyn.ts");
    expect(diagnostics.map((d) => d.rule)).toEqual(["no-bare-import", "no-bare-import"]);
    expect(diagnostics.map((d) => d.line)).toEqual([2, 3]);
    expect(diagnostics[1]?.message).toContain("literal relative specifier");
  });

  it("exempts type-only imports, which never reach the bundle", () => {
    const source = [`import type { Stats } from "node:fs";`, `export type { Stats };`].join("\n");
    expect(checkSource(source, "types.ts")).toEqual([]);
  });

  it("honours a custom allow-list, and keeps @techery/weft-sdk allowed regardless", () => {
    const source = [
      `import { defineWorkflow } from "@techery/weft-sdk";`,
      `import ky from "ky";`,
      `import { z } from "zod";`,
    ].join("\n");
    const diagnostics = checkSource(source, "custom.ts", ["ky"]);
    expect(diagnostics.map((d) => [d.rule, d.line])).toEqual([["no-bare-import", 3]]);
    expect(checkSource(source, "custom.ts", ["ky", "zod"])).toEqual([]);
  });

  it("reports every violation in one pass", () => {
    const source = [
      `import lodash from "lodash";`,
      `export function bad() {`,
      `  const t = Date.now();`,
      `  const r = Math.random();`,
      `  return process.env.HOME ?? String(t + r);`,
      `}`,
    ].join("\n");
    expect(checkSource(source, "bad.ts").map((d) => d.rule)).toEqual([
      "no-bare-import",
      "no-date-now",
      "no-math-random",
      "no-process-env",
    ]);
  });

  it("defaults the file name", () => {
    expect(checkSource("Date.now();")[0]?.file).toBe("<workflow>");
  });

  it("renders diagnostics with their fix-its", () => {
    const diagnostics = checkSource(`  const t = Date.now();`, "bad.ts");
    expect(formatDiagnostics(diagnostics)).toBe(
      [
        "  bad.ts:1:13  no-date-now  Date.now() is not allowed in workflow code",
        "    fix: Date.now() is unavailable - use ctx.now()",
      ].join("\n"),
    );
    const err = new GateError("boom", diagnostics);
    expect(err.name).toBe("GateError");
    expect(err).toBeInstanceOf(Error);
    expect(err.diagnostics).toBe(diagnostics);
  });
});

// ---------------------------------------------------------------------------
// bundleWorkflow
// ---------------------------------------------------------------------------

describe("bundleWorkflow", () => {
  it("inlines relative imports and keeps @techery/weft-sdk external", async () => {
    const dir = await tempDir();
    const entry = await writeReview(dir);

    const { code, hash, diagnostics } = await bundleWorkflow({ entry });

    expect(diagnostics).toEqual([]);
    expect(code).toContain('require("@techery/weft-sdk")'); // the SDK stays external
    expect(code).toContain("var Finding = "); // …while schemas.ts is inlined
    expect(code).not.toContain('require("./schemas.ts")');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves extensionless relative imports", async () => {
    const dir = await tempDir();
    await write(dir, "schemas.ts", SCHEMAS);
    const entry = await write(dir, "review.ts", reviewSource().replace("./schemas.ts", "./schemas"));
    const { code } = await bundleWorkflow({ entry });
    expect(code).toContain("Finding");
  });

  it("bundles inline source against cwd", async () => {
    const dir = await tempDir();
    await write(dir, "schemas.ts", SCHEMAS);
    const { code, hash } = await bundleWorkflow({ source: reviewSource(), cwd: dir });
    expect(code).toContain('require("@techery/weft-sdk")');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws GateError for a violation in the entry", async () => {
    const dir = await tempDir();
    const entry = await write(dir, "bad.ts", sandboxProbe({ body: `const t = Date.now();` }));

    const err = await bundleWorkflow({ entry }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateError);
    const gate = err as GateError;
    expect(gate.diagnostics.map((d) => d.rule)).toEqual(["no-date-now"]);
    expect(gate.diagnostics[0]?.file).toBe("bad.ts");
    expect(gate.message).toContain("no-date-now");
    expect(gate.message).toContain("use ctx.now()");
  });

  it("catches violations inside a relative import", async () => {
    const dir = await tempDir();
    await write(
      dir,
      "schemas.ts",
      [
        `import { z } from "@techery/weft-sdk";`,
        `const seed = Math.random();`,
        `export const Finding = z.object({ file: z.string(), note: z.string(), seed: z.literal(seed) });`,
      ].join("\n"),
    );
    const entry = await write(dir, "review.ts", reviewSource());

    const err = await bundleWorkflow({ entry }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateError);
    const [d, ...rest] = (err as GateError).diagnostics;
    expect(rest).toEqual([]);
    expect(d?.rule).toBe("no-math-random");
    expect(d?.file).toBe("schemas.ts");
    expect(d?.line).toBe(2);
  });

  it("catches violations in inline source", async () => {
    const dir = await tempDir();
    const err = await bundleWorkflow({ source: `setTimeout(() => {}, 1);`, cwd: dir }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GateError);
    expect((err as GateError).diagnostics[0]).toMatchObject({ rule: "no-timers", file: "<inline>", line: 1 });
  });

  it("reports an unresolvable import as a bundle failure", async () => {
    const dir = await tempDir();
    const entry = await write(dir, "review.ts", reviewSource()); // no schemas.ts written
    const err = await bundleWorkflow({ entry }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateError);
    expect((err as GateError).diagnostics[0]?.rule).toBe("bundle-failed");
    expect((err as GateError).message).toMatch(/schemas/);
  });

  it("requires an entry or source", async () => {
    await expect(bundleWorkflow({})).rejects.toBeInstanceOf(GateError);
  });

  it("hashes identical content identically and changed content differently", async () => {
    const dirA = await tempDir();
    const entryA = await writeReview(dirA);
    const first = await bundleWorkflow({ entry: entryA });
    const again = await bundleWorkflow({ entry: entryA });
    expect(again.hash).toBe(first.hash);
    expect(again.code).toBe(first.code);

    // Same content, different directory: the hash is content-addressed, not path-addressed.
    const dirB = await tempDir();
    const entryB = await writeReview(dirB);
    expect((await bundleWorkflow({ entry: entryB })).hash).toBe(first.hash);

    // A changed entry changes the hash…
    await write(dirA, "review.ts", reviewSource({ note: "different" }));
    const edited = await bundleWorkflow({ entry: entryA });
    expect(edited.hash).not.toBe(first.hash);

    // …and so does a changed relative import, because it is part of the bundle.
    await write(dirB, "schemas.ts", SCHEMAS.replace("note: z.string()", "note: z.string().min(1)"));
    expect((await bundleWorkflow({ entry: entryB })).hash).not.toBe(first.hash);
  });
});

// ---------------------------------------------------------------------------
// loadWorkflow
// ---------------------------------------------------------------------------

describe("loadWorkflow", () => {
  it("returns a runnable definition with host-zod schemas", async () => {
    const dir = await tempDir();
    const entry = await writeReview(dir);

    const { def, hash, code, name } = await loadWorkflow({ entry });

    expect(name).toBe("review");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(code).toContain('require("@techery/weft-sdk")');
    expect(def.kind).toBe("weft.workflow");
    expect(def.meta.description).toBe("Review a target and report findings");

    // The schemas are real host-zod instances: the engine can validate against them.
    expect(isZodSchema(def.meta.input)).toBe(true);
    expect(await validateSchema(def.meta.input, { target: "src/a.ts" })).toEqual({
      ok: true,
      value: { target: "src/a.ts" },
    });
    const bad = await validateSchema(def.meta.input, { target: 42 });
    expect(bad.ok).toBe(false);

    // …and the run function executes against a plain stub ctx.
    const out = (await def.run(stubCtx, { target: "src/a.ts" })) as { findings: unknown[]; at: number };
    expect(out).toEqual({ findings: [{ file: "src/a.ts", note: "looks fine" }], at: 1_700_000_000_000 });
    expect(await validateSchema(def.meta.output, out)).toMatchObject({ ok: true });
  });

  it("prefers meta.name, then opts.name, then the file name", async () => {
    const dir = await tempDir();
    const named = await writeReview(dir, "on-disk.ts", { name: "renamed" });
    expect((await loadWorkflow({ entry: named })).name).toBe("renamed");
    expect((await loadWorkflow({ entry: named, name: "ignored" })).name).toBe("renamed");

    const plain = await writeReview(dir, "plain.ts");
    expect((await loadWorkflow({ entry: plain })).name).toBe("plain");
    expect((await loadWorkflow({ entry: plain, name: "override" })).name).toBe("override");
  });

  it("loads inline source, defaulting the name to inline", async () => {
    const dir = await tempDir();
    await write(dir, "schemas.ts", SCHEMAS);
    const loaded = await loadWorkflow({ source: reviewSource(), cwd: dir });
    expect(loaded.name).toBe("inline");
    expect(await loaded.def.run(stubCtx, { target: "x" })).toMatchObject({ at: 1_700_000_000_000 });
    expect((await loadWorkflow({ source: reviewSource(), cwd: dir, name: "session-script" })).name).toBe(
      "session-script",
    );
  });

  it("rejects a module that exports no workflow", async () => {
    const dir = await tempDir();
    const entry = await write(dir, "helpers.ts", `export const answer = 42;`);
    await expect(loadWorkflow({ entry })).rejects.toThrow(/no workflow definition exported/);

    const rolled = await write(
      dir,
      "rolled.ts",
      `export default { kind: "weft.workflow", run: async () => ({}) };`,
    );
    await expect(loadWorkflow({ entry: rolled })).rejects.toThrow(/no workflow definition exported/);
  });

  it("refuses a workflow whose top level reads the clock, with the fix-it", async () => {
    const dir = await tempDir();
    const entry = await write(dir, "stamped.ts", sandboxProbe({ top: `const stamped = Date.now();` }));
    await expect(loadWorkflow({ entry })).rejects.toThrow(/Date\.now\(\) is unavailable - use ctx\.now\(\)/);
  });

  it("accepts a definition on module.exports without a default", async () => {
    const code = [
      `const { defineWorkflow, z } = require("@techery/weft-sdk");`,
      `module.exports = defineWorkflow(`,
      `  { description: "cjs", input: z.object({}), output: z.object({ ok: z.boolean() }) },`,
      `  async () => ({ ok: true }),`,
      `);`,
    ].join("\n");
    const def = await instantiateBundle(code, { filename: "cjs.ts" });
    expect(def.meta.description).toBe("cjs");
  });
});

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

describe("sandbox", () => {
  /** Load a probe that dodges the AST rules, so only the sandbox can stop it. */
  async function loadProbe(opts: {
    top?: string;
    body?: string;
  }): Promise<Awaited<ReturnType<typeof loadWorkflow>>> {
    const dir = await tempDir();
    const entry = await write(dir, "probe.ts", sandboxProbe(opts));
    return loadWorkflow({ entry });
  }

  it("fails a module whose top level reads the clock", async () => {
    // `const D = Date; D.now()` is invisible to the AST rules — this is the fence's job.
    const err = await loadProbe({ top: `const D: any = Date;\nconst stamped = D.now();` }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GateError);
    expect((err as GateError).message).toBe("Date.now() is unavailable in workflow code - use ctx.now()");
    expect((err as GateError).diagnostics[0]?.rule).toBe("sandbox");
    expect((err as GateError).diagnostics[0]?.file).toBe("probe.ts");
  });

  it("blocks a clock read inside run()", async () => {
    const { def } = await loadProbe({ top: `const D: any = Date;`, body: `const t = D.now();` });
    await expect(def.run(stubCtx, {})).rejects.toThrow(
      "Date.now() is unavailable in workflow code - use ctx.now()",
    );
  });

  it("blocks argless new Date() but allows new Date(value)", async () => {
    const blocked = await loadProbe({ top: `const D: any = Date;`, body: `const d = new D();` });
    await expect(blocked.def.run(stubCtx, {})).rejects.toThrow(
      "new Date() is unavailable in workflow code - use ctx.now()",
    );

    const allowed = await loadProbe({
      top: `const D: any = Date;`,
      body: [
        `const iso = new Date(0).toISOString();`,
        `if (iso !== "1970-01-01T00:00:00.000Z") throw new Error(iso);`,
      ].join("\n    "),
    });
    await expect(allowed.def.run(stubCtx, {})).resolves.toEqual({ ok: true });
  });

  it("blocks plain Date() without new", async () => {
    // Date() as a call returns the current time as a string — a clock read too.
    const { def } = await loadProbe({ top: `const D: any = Date;`, body: `const s = D();` });
    await expect(def.run(stubCtx, {})).rejects.toThrow(
      "Date() is unavailable in workflow code - use ctx.now()",
    );
  });

  it("blocks the raw constructor reachable through instances", async () => {
    // new Date(0).constructor and Date.prototype.constructor both land on the
    // guarded proxy, not the raw callable Date (which would read the clock).
    const viaInstance = await loadProbe({
      top: `const D: any = Date;`,
      body: `const t = new D(0).constructor();`,
    });
    await expect(viaInstance.def.run(stubCtx, {})).rejects.toThrow(
      "Date() is unavailable in workflow code - use ctx.now()",
    );
    const viaProto = await loadProbe({
      top: `const D: any = Date;`,
      body: `const t = D.prototype.constructor();`,
    });
    await expect(viaProto.def.run(stubCtx, {})).rejects.toThrow(
      "Date() is unavailable in workflow code - use ctx.now()",
    );
  });

  it("gives Function-escapes the sandboxed globals, not the host's", async () => {
    // Promise is a context-native intrinsic (not injected from the host), so code
    // built via its .constructor evaluates against the SANDBOXED globals: the Date
    // it reaches is the guarded stand-in, and process.env is the throwing proxy.
    const clock = await loadProbe({
      top: `const P: any = Promise;`,
      body: `const t = P.constructor("return Date.now()")();`,
    });
    await expect(clock.def.run(stubCtx, {})).rejects.toThrow(
      "Date.now() is unavailable in workflow code - use ctx.now()",
    );
    const env = await loadProbe({
      top: `const P: any = Promise;`,
      body: `const e = P.constructor("return process.env.HOME")();`,
    });
    await expect(env.def.run(stubCtx, {})).rejects.toThrow("process.env is unavailable");
  });

  it("keeps Date.parse and the rest of Math working", async () => {
    const { def } = await loadProbe({
      body: [
        `const parsed = Date.parse("2026-01-01T00:00:00.000Z");`,
        `if (Math.max(parsed, 1) !== parsed) throw new Error("math");`,
      ].join("\n    "),
    });
    await expect(def.run(stubCtx, {})).resolves.toEqual({ ok: true });
  });

  it("blocks Math.random", async () => {
    const { def } = await loadProbe({ top: `const M: any = Math;`, body: `const r = M.random();` });
    await expect(def.run(stubCtx, {})).rejects.toThrow(
      "Math.random() is unavailable in workflow code - use ctx.random()",
    );
  });

  it("blocks process.env", async () => {
    const { def } = await loadProbe({
      top: `const p: any = (globalThis as any).process;`,
      body: `const token = p.env.TOKEN;`,
    });
    await expect(def.run(stubCtx, {})).rejects.toThrow(
      "process.env is unavailable - use ctx.env.get() / ctx.secret()",
    );
  });

  it("blocks global fetch and the timers", async () => {
    const fetcher = await loadProbe({
      top: `const f: any = (globalThis as any).fetch;`,
      body: `await f("https://example.com");`,
    });
    await expect(fetcher.def.run(stubCtx, {})).rejects.toThrow(
      /fetch\(\) is unavailable in workflow code - use ctx\.fetch/,
    );

    const timer = await loadProbe({
      top: `const t: any = (globalThis as any).setTimeout;`,
      body: `t(() => {}, 5);`,
    });
    await expect(timer.def.run(stubCtx, {})).rejects.toThrow(
      /setTimeout\(\) is unavailable in workflow code/,
    );

    const immediate = await loadProbe({
      top: `const t: any = (globalThis as any).setImmediate;`,
      body: `t(() => {});`,
    });
    await expect(immediate.def.run(stubCtx, {})).rejects.toThrow(
      /setImmediate\(\) is unavailable in workflow code/,
    );
  });

  it("refuses a module that requires a package outside the allow-list", async () => {
    // `const req = require` dodges the no-require rule; the require shim is the backstop.
    const err = await loadProbe({
      top: `const req: any = require;\nconst _ = req("lodash");`,
      body: ``,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateError);
    expect((err as GateError).message).toBe('import "lodash" is not allowed in workflow code');
  });

  it("hands the host's own modules to allow-listed requires", async () => {
    const code = [
      `const sdk = require("@techery/weft-sdk");`,
      `const zod = require("zod");`,
      `module.exports = sdk.defineWorkflow(`,
      `  { description: "hosted", input: zod.z.object({}), output: zod.z.object({ ok: zod.z.boolean() }) },`,
      `  async () => ({ ok: true }),`,
      `);`,
    ].join("\n");
    const def = await instantiateBundle(code);
    const sdk = await import("@techery/weft-sdk");
    expect(def.meta.input.constructor).toBe(sdk.z.object({}).constructor);
  });

  it("gives console and the structured-clone-safe globals through", async () => {
    const { def } = await loadProbe({
      body: [
        `console.log("hello from a workflow");`,
        `const u = new URL("https://example.com/a?b=1");`,
        `if (u.searchParams.get("b") !== "1") throw new Error("URL");`,
        `const round = structuredClone({ a: [1, 2] });`,
        `if (JSON.stringify(round) !== '{"a":[1,2]}') throw new Error("clone");`,
        `if (new TextDecoder().decode(new TextEncoder().encode("ok")) !== "ok") throw new Error("text");`,
      ].join("\n    "),
    });
    await expect(def.run(stubCtx, {})).resolves.toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("createWorkflowRegistry", () => {
  it("lists and loads workflows by file name", async () => {
    const dir = await tempDir();
    await writeReview(dir, "review.ts");
    await write(dir, "ship.ts", reviewSource({ description: "Ship it" }));
    const registry = createWorkflowRegistry({ dir });

    const listed = await registry.list();
    expect(listed.map((e) => e.name)).toEqual(["review", "ship"]);
    expect(listed[0]?.description).toBe("Review a target and report findings");
    expect(listed[1]?.description).toBe("Ship it");
    expect(listed[0]?.file).toBe(path.join(dir, "review.ts"));

    const loaded = await registry.load("review");
    expect(loaded.file).toBe(path.join(dir, "review.ts"));
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await loaded.def.run(stubCtx, { target: "x" })).toMatchObject({ at: 1_700_000_000_000 });

    const got = await registry.get("review");
    expect(got).toBe(loaded.def);
    expect(await registry.get("nope")).toBeUndefined();
    await expect(registry.load("nope")).rejects.toThrow(/not found/);
  });

  it("skips helper modules that are not workflows", async () => {
    const dir = await tempDir();
    await writeReview(dir, "review.ts"); // also writes schemas.ts beside it
    await write(dir, "lib/util.ts", `export const two = 2;`);
    const registry = createWorkflowRegistry({ dir });
    expect((await registry.list()).map((e) => e.name)).toEqual(["review"]);
    expect(await registry.get("schemas")).toBeUndefined();
  });

  it("lets meta.name override the file name", async () => {
    const dir = await tempDir();
    await writeReview(dir, "on-disk.ts", { name: "review-pass" });
    const registry = createWorkflowRegistry({ dir });

    expect((await registry.list()).map((e) => e.name)).toEqual(["review-pass"]);
    expect(await registry.get("on-disk")).toBeUndefined();
    const loaded = await registry.load("review-pass");
    expect(loaded.file).toBe(path.join(dir, "on-disk.ts"));
  });

  it("rejects duplicate durable workflow ids", async () => {
    const dir = await tempDir();
    await writeReview(dir, "review.ts", { id: "shared-state" });
    await write(dir, "ship.ts", reviewSource({ id: "shared-state", description: "Ship it" }));
    const registry = createWorkflowRegistry({ dir });
    await expect(registry.list()).rejects.toThrow(/duplicate workflow id "shared-state"/);
    await expect(registry.load("review")).rejects.toThrow(/duplicate workflow id "shared-state"/);
    await expect(registry.get("review")).rejects.toThrow(/duplicate workflow id "shared-state"/);
  });

  it("rejects duplicate callable workflow names even when their durable ids differ", async () => {
    const dir = await tempDir();
    await writeReview(dir, "review.ts", { id: "review-one", name: "shared-name" });
    await write(
      dir,
      "ship.ts",
      reviewSource({ id: "review-two", name: "shared-name", description: "Ship it" }),
    );
    const registry = createWorkflowRegistry({ dir });

    await expect(registry.list()).rejects.toThrow(/duplicate workflow name "shared-name"/);
    await expect(registry.load("shared-name")).rejects.toThrow(/duplicate workflow name "shared-name"/);
  });

  it("caches by content hash and invalidates when the file changes", async () => {
    const dir = await tempDir();
    await writeReview(dir, "review.ts");
    const registry = createWorkflowRegistry({ dir });

    const first = await registry.load("review");
    const second = await registry.load("review");
    expect(second.def).toBe(first.def);
    expect(second.hash).toBe(first.hash);

    await write(dir, "review.ts", reviewSource({ description: "Review, again" }));
    const third = await registry.load("review");
    expect(third.hash).not.toBe(first.hash);
    expect(third.def).not.toBe(first.def);
    expect(third.def.meta.description).toBe("Review, again");
    expect((await registry.list())[0]?.description).toBe("Review, again");
  });

  it("invalidates when a bundled relative import changes", async () => {
    const dir = await tempDir();
    await writeReview(dir, "review.ts");
    const registry = createWorkflowRegistry({ dir });
    const first = await registry.load("review");

    await write(dir, "schemas.ts", SCHEMAS.replace("note: z.string()", "note: z.string().min(4)"));
    const second = await registry.load("review");
    expect(second.hash).not.toBe(first.hash);
    expect(second.def).not.toBe(first.def);
    expect(
      await validateSchema(second.def.meta.output, { findings: [{ file: "a", note: "no" }], at: 1 }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("propagates a gate violation for the workflow that was asked for", async () => {
    const dir = await tempDir();
    await write(dir, "broken.ts", sandboxProbe({ body: `const t = Date.now();` }));
    const registry = createWorkflowRegistry({ dir });
    await expect(registry.load("broken")).rejects.toThrow(/no-date-now/);
    expect(await registry.list()).toEqual([]);
  });

  it("tolerates a missing directory", async () => {
    const registry = createWorkflowRegistry({ dir: path.join(await tempDir(), "no-such-dir") });
    expect(await registry.list()).toEqual([]);
    expect(await registry.get("review")).toBeUndefined();
    await expect(registry.load("review")).rejects.toThrow(/not found/);
  });

  it("propagates a directory that exists but cannot be read (codex review round 55, PR #1)", async () => {
    // A self-referential symlink makes readdir fail with ELOOP — an error that
    // is NOT absence. Reporting it as an empty registry would silently hide
    // every workflow; it must surface instead. (EACCES is the everyday case,
    // but tests run as root, where permission bits do not bite.)
    const dir = path.join(await tempDir(), "workflows");
    await symlink(dir, dir);
    const registry = createWorkflowRegistry({ dir });
    await expect(registry.list()).rejects.toThrow(/cannot read workflow directory/);
    await expect(registry.load("review")).rejects.toThrow(/cannot read workflow directory/);
  });

  it("passes its allow-list down to the gate", async () => {
    const dir = await tempDir();
    await write(
      dir,
      "wf.ts",
      [
        `import { defineWorkflow } from "@techery/weft-sdk";`,
        `import { z } from "zod";`,
        `export default defineWorkflow(`,
        `  {`,
        `    description: "zod straight from the package",`,
        `    input: z.object({}),`,
        `    output: z.object({ ok: z.boolean() }),`,
        `  },`,
        `  async () => ({ ok: true }),`,
        `);`,
      ].join("\n"),
    );
    expect(await createWorkflowRegistry({ dir, allowBare: [] }).list()).toEqual([]);
    expect((await createWorkflowRegistry({ dir, allowBare: ["zod"] }).list()).map((e) => e.name)).toEqual([
      "wf",
    ]);
  });
});
