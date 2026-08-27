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
          [path.join(testsDir, "main.test.ts"), TEST_TEMPLATE],
          [path.join(packageDir, "CHANGELOG.md"), changelogTemplate(name)],
        ] as const;
        await Promise.all(files.map(([file, contents]) => writeFile(file, contents, "utf8")));
        for (const [file] of files) io.out(`${pc.green("created")} ${path.relative(weft.cwd, file)}`);
        const runArgs =
          template === "review" ? " --base main" : template === "simple" ? ' --request "…"' : "";
        say(io, pc.dim(`next: weft check ${name} · weft run ${name}${runArgs} --watch`));
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
    const findings = reviews.flatMap((review) => review.findings);

    ctx.phase("Verify");
    // The pipeline keeps each finding paired with its verdict, so a failed
    // refuter branch drops its own lane instead of misaligning the rest.
    const confirmed = ctx.all(
      await ctx.pipeline(findings)
        .step((finding) =>
          ctx.agent(\`Try to refute this finding: \${finding.claim} (\${finding.file}:\${finding.line})\`, {
            key: \`refute:\${finding.file}:\${finding.line}:\${finding.claim}\`,
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

const TEST_TEMPLATE = `import assert from "node:assert/strict";
import test from "node:test";
import workflow from "../main.ts";

test("workflow exposes a durable identity and description", () => {
  assert.equal(typeof workflow.meta.id, "string");
  assert.ok(workflow.meta.description.length > 0);
});
`;

function changelogTemplate(name: string): string {
  return `# ${name} changelog

## Unreleased

- Initial workflow package.
`;
}
