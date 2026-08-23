/**
 * `weft new <name>` — the scaffold. It writes a workflow that already has the shape worth
 * copying: phases, keyed fan-out, a second opinion before anything is believed, a note in
 * the ledger. It passes `weft check` as written, so the first edit starts from green.
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
    .description("scaffold a workflow (plus schemas.ts) in the workflow directory")
    .argument("<name>", "workflow name; also the filename")
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      if (!/^[a-z][a-z0-9-]*$/i.test(name)) {
        throw new Error(`invalid workflow name ${JSON.stringify(name)} — letters, digits and dashes`);
      }
      const weft = await openWeft(cmd);
      try {
        const dir = workflowsDir(weft);
        const file = path.join(dir, `${name}.ts`);
        if (existsSync(file)) {
          throw new Error(`${path.relative(weft.cwd, file)} already exists — pick another name or edit it`);
        }
        await mkdir(dir, { recursive: true });
        await writeFile(file, workflowTemplate(name), "utf8");
        io.out(`${pc.green("created")} ${path.relative(weft.cwd, file)}`);

        const schemas = path.join(dir, "schemas.ts");
        if (existsSync(schemas)) {
          io.out(pc.dim(`kept    ${path.relative(weft.cwd, schemas)} (already there)`));
        } else {
          await writeFile(schemas, SCHEMAS_TEMPLATE, "utf8");
          io.out(`${pc.green("created")} ${path.relative(weft.cwd, schemas)}`);
        }
        say(io, pc.dim(`next: weft check ${name} · weft run ${name} --base main --watch`));
      } finally {
        await weft.close();
      }
    });
}

/** The name comes from the filename, so the template never hard-codes `meta.name`. */
function workflowTemplate(name: string): string {
  return `import { defineWorkflow, z } from "@weft/sdk";
import { Finding } from "./schemas.ts";

/**
 * ${name}: review what changed since a base ref, then keep only the findings that
 * survive a second agent trying to refute them.
 */
export default defineWorkflow(
  {
    description: "Review changed files; keep only findings that survive refutation",
    input: z.object({ base: z.string().default("main") }),
    output: z.object({ confirmed: z.array(Finding), reviewed: z.number() }),
  },
  async (ctx, input) => {
    ctx.phase("Find");
    const changed = await ctx.git.changedSince(input.base);
    const files = changed.files.filter((f) => f.status !== "D").map((f) => f.path);
    if (files.length === 0) return { confirmed: [], reviewed: 0 };

    const reviews = ctx.ok(
      await ctx.parallel(
        files.map(
          (file) => () =>
            ctx.agent(\`Review \${file} for real bugs. Cite the line for every claim.\`, {
              key: \`find:\${file}\`,
              schema: z.object({ findings: z.array(Finding) }),
            }),
        ),
      ),
    );
    const findings = reviews.flatMap((review) => review.findings);

    ctx.phase("Verify");
    const verdicts = ctx.ok(
      await ctx.parallel(
        findings.map(
          (finding, i) => () =>
            ctx.agent(\`Try to refute this finding: \${finding.claim} (\${finding.file}:\${finding.line})\`, {
              key: \`refute:\${i}\`,
              schema: z.object({ survives: z.boolean(), why: z.string() }),
            }),
        ),
      ),
    );
    const confirmed = findings.filter((_, i) => verdicts[i]?.survives === true);

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

const SCHEMAS_TEMPLATE = `import { z } from "@weft/sdk";

/** One reviewable claim: what, where, and how much it matters. */
export const Finding = z.object({
  file: z.string(),
  line: z.number().int(),
  claim: z.string(),
  severity: z.enum(["low", "medium", "high"]),
});
`;
