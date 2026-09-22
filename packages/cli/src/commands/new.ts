/**
 * `weft new <name>` — scaffold a self-contained workflow package. Every package owns one
 * `main.ts` entry point, supporting code under `lib/`, tests under `tests/`, and its own
 * changelog. It passes `weft check` as written, so the first edit starts from green.
 *
 * Nothing is ever overwritten. A scaffold that clobbers a file people have been editing is
 * a scaffold nobody runs twice.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { openWeft, workflowsDir } from "../context.ts";
import { type CliIo, say } from "../io.ts";

export function newCommand(io: CliIo): Command {
  return new Command("new")
    .description("scaffold a workflow package with main.ts, lib/, tests/, and CHANGELOG.md")
    .argument("<name>", "workflow name; also the package directory")
    .option("--template <kind>", "simple, review, or task", "review")
    .action(async (name: string, opts: { template?: string }, cmd: Command) => {
      if (!/^[a-z][a-z0-9-]*$/i.test(name)) {
        throw new Error(`invalid workflow name ${JSON.stringify(name)} — letters, digits and dashes`);
      }
      const template = opts.template ?? "review";
      if (!(["simple", "review", "task"] as const).includes(template as never)) {
        throw new Error(`invalid template ${JSON.stringify(template)} — expected simple, review, or task`);
      }
      const weft = await openWeft(cmd);
      try {
        const dir = workflowsDir(weft);
        const packageDir = path.join(dir, name);
        const legacyFile = path.join(dir, `${name}.ts`);
        if (existsSync(packageDir) || existsSync(legacyFile)) {
          const existing = existsSync(packageDir) ? packageDir : legacyFile;
          throw new Error(
            `${path.relative(weft.cwd, existing)} already exists — pick another name or edit it`,
          );
        }
        const libDir = path.join(packageDir, "lib");
        const testsDir = path.join(packageDir, "tests");
        await Promise.all([mkdir(libDir, { recursive: true }), mkdir(testsDir, { recursive: true })]);
        const files = [
          [
            path.join(packageDir, "main.ts"),
            workflowTemplate(name, template as "simple" | "review" | "task"),
          ],
          [
            path.join(libDir, template === "review" ? "schemas.ts" : "index.ts"),
            template === "review" ? SCHEMAS_TEMPLATE : LIB_TEMPLATE,
          ],
          [path.join(testsDir, "main.test.ts"), testTemplate(template as "simple" | "review" | "task")],
          [path.join(packageDir, "CHANGELOG.md"), changelogTemplate(name)],
        ] as const;
        await Promise.all(files.map(([file, contents]) => writeFile(file, contents, "utf8")));
        for (const [file] of files) io.out(`${pc.green("created")} ${path.relative(weft.cwd, file)}`);
        const runArgs =
          template === "review" ? " --base main" : template === "simple" ? ' --request "…"' : "";
        say(
          io,
          pc.dim(
            `next: weft check ${name} --strict · weft test ${name} · weft run ${name}${runArgs} --watch`,
          ),
        );
      } finally {
        await weft.close();
      }
    });
}

/** The name comes from the package directory, so the template never hard-codes `meta.name`. */
function workflowTemplate(name: string, template: "simple" | "review" | "task"): string {
  if (template === "simple") return simpleTemplate(name);
  if (template === "task") return taskTemplate(name);
  return `import { defineWorkflow, z } from "@techery/weft-sdk";
import { findingKey, uniqueFindings } from "@techery/weft-stdlib";
import { Finding } from "./lib/schemas.ts";

/**
 * ${name}: review what changed since a base ref, then keep only the findings that
 * survive a second agent trying to refute them.
 */
export default defineWorkflow(
  {
    id: "${name}",
    description: "Review changed files; keep only findings that survive refutation",
    input: z.object({ base: z.string().default("main") }),
    output: z.object({ confirmed: z.array(Finding), reviewed: z.number() }),
  },
  async (ctx, input) => {
    ctx.phase("Find");
    const changed = await ctx.git.changedSince(input.base);
    const files = changed.files.filter((f) => f.status !== "D").map((f) => f.path);
    if (files.length === 0) return { confirmed: [], reviewed: 0 };

    const reviews = ctx.all(
      await ctx.parallel(
        files,
        (file) =>
          ctx.agent(\`Review \${file} for real bugs. Cite the line for every claim.\`, {
            key: \`find:\${file}\`,
            schema: z.object({ findings: z.array(Finding) }),
          }),
        { concurrency: 4, errors: "throw" },
      ),
    );
    const findings = uniqueFindings(reviews.flatMap((review) => review.findings));

    ctx.phase("Verify");
    // Keep every verdict paired with its source. Required reviewers fail the run.
    const confirmed = ctx.all(
      await ctx.pipeline(findings)
        .step((finding) =>
          ctx.agent(\`Try to refute this finding: \${finding.claim} (\${finding.file}:\${finding.line})\`, {
            key: \`refute:\${findingKey(finding)}\`,
            schema: z.object({ survives: z.boolean(), why: z.string() }),
          }),
        )
        .filter((verdict) => verdict.survives)
        .map((_verdict, finding) => finding)
        .run({ concurrency: 4, errors: "throw" }),
    );

    ctx.phase("Report");
    await ctx.note({
      kind: "claim",
      text: \`\${confirmed.length} of \${findings.length} findings survived refutation\`,
    });
    return { confirmed, reviewed: files.length };
  },
);
`;
}

function simpleTemplate(name: string): string {
  return `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    id: "${name}",
    description: "Run one typed agent step",
    input: z.object({ request: z.string() }),
    output: z.object({ answer: z.string() }),
  },
  async (ctx, input) =>
    ctx.agent(input.request, {
      key: "answer",
      schema: z.object({ answer: z.string() }),
    }),
);
`;
}

function taskTemplate(name: string): string {
  return `import { defineTaskContract, defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    id: "${name}",
    description: "Inspect durable workflow tasks and report the active queue",
    input: z.object({}),
    output: z.object({ active: z.number(), summary: z.string() }),
    tasks: defineTaskContract({
      schema: z.object({ owner: z.string().optional() }),
      revision: "${name}-tasks-v1",
      agentAccess: "read",
    }),
  },
  async (ctx) => {
    const snapshot = await ctx.tasks.observe(
      { statuses: ["todo", "in_progress", "blocked"] },
      { key: "tasks:active" },
    );
    const report = await ctx.agent(
      \`Summarize these active tasks:\\n\${JSON.stringify(snapshot.tasks)}\`,
      {
        key: "summarize-tasks",
        schema: z.object({ summary: z.string() }),
      },
    );
    return { active: snapshot.tasks.length, summary: report.summary };
  },
);
`;
}

const SCHEMAS_TEMPLATE = `import { z } from "@techery/weft-sdk";

/** One reviewable claim: what, where, and how much it matters. */
export const Finding = z.object({
  file: z.string(),
  line: z.number().int(),
  claim: z.string(),
  severity: z.enum(["low", "medium", "high"]),
});

`;

const LIB_TEMPLATE = `/** Supporting workflow code belongs in this directory. */
export {};
`;

function testTemplate(template: "simple" | "review" | "task"): string {
  const imports = `import assert from "node:assert/strict";
import test from "node:test";
import { mock, runWorkflow } from "@techery/weft-testing";
import workflow from "../main.ts";

`;
  if (template === "simple")
    return `${imports}test("returns the typed answer and fails when no agent fixture matches", async () => {
  const result = await runWorkflow(workflow, {
    input: { request: "Explain the change" },
    fixtureMode: "strict",
    provider: mock().on({ key: "answer" }, { answer: "A verified answer" }),
  });
  assert.deepEqual(result.output, { answer: "A verified answer" });
  assert.equal(result.journal.steps({ kind: "agent" }).length, 1);
  await assert.rejects(runWorkflow(workflow, { input: { request: "Explain the change" }, fixtureMode: "strict" }), /no fixture matches/);
});
`;
  if (template === "task")
    return `${imports}test("reports the active durable task queue", async () => {
  const result = await runWorkflow(workflow, {
    input: {},
    fixtureMode: "strict",
    taskSeeds: [{ title: "Investigate regression", description: "Reproduce and fix the failure", status: "todo", extensions: {} }],
    provider: mock().on({ key: "summarize-tasks" }, { summary: "One active task" }),
  });
  assert.deepEqual(result.output, { active: 1, summary: "One active task" });
  assert.equal(result.tasks.tasks.length, 1);
});

test("fails when the summary has no matching fixture", async () => {
  await assert.rejects(runWorkflow(workflow, { input: {}, fixtureMode: "strict" }), /no fixture matches/);
});
`;
  return `${imports}const finding = { file: "a.ts", line: 3, claim: "Off-by-one", severity: "high" as const };
const git = { changedSince: { files: [{ path: "a.ts", status: "M" }] } };

test("keeps a confirmed finding with its source and reports the reviewed count", async () => {
  const result = await runWorkflow(workflow, {
    input: { base: "main" },
    fixtureMode: "strict",
    git,
    provider: mock()
      .on({ key: "find:*" }, { findings: [finding] })
      .on({ key: "refute:*" }, { survives: true, why: "The loop exceeds its bound" }),
  });
  assert.deepEqual(result.output, { confirmed: [finding], reviewed: 1 });
  assert.equal(result.journal.steps({ kind: "agent" }).length, 2);
});

test("does not report success when a reviewer fails", async () => {
  await assert.rejects(runWorkflow(workflow, {
    input: { base: "main" }, fixtureMode: "strict", git,
  }), /no fixture matches/);
});

test("does not report success when a refuter fails", async () => {
  await assert.rejects(runWorkflow(workflow, {
    input: { base: "main" }, fixtureMode: "strict", git,
    provider: mock().on({ key: "find:*" }, { findings: [finding] }),
  }), /no fixture matches/);
});

test("retains different claims on one line and removes duplicate claims", async () => {
  const second = { ...finding, claim: "Missing validation" };
  const result = await runWorkflow(workflow, {
    input: { base: "main" }, fixtureMode: "strict", git,
    provider: mock()
      .on({ key: "find:*" }, { findings: [finding, second, finding] })
      .on({ key: "refute:*" }, { survives: true, why: "Confirmed independently" }),
  });
  assert.deepEqual(result.output.confirmed, [finding, second]);
  assert.equal(result.journal.steps({ kind: "agent" }).length, 3);
});

test("returns an empty review only when no changed files need review", async () => {
  const result = await runWorkflow(workflow, {
    input: { base: "main" }, fixtureMode: "strict", git: { changedSince: { files: [] } },
  });
  assert.deepEqual(result.output, { confirmed: [], reviewed: 0 });
  assert.equal(result.journal.steps({ kind: "agent" }).length, 0);
});
`;
}

function changelogTemplate(name: string): string {
  return `# ${name} changelog

## Unreleased

- Initial workflow package.
`;
}
