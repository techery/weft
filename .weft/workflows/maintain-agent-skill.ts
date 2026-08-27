/**
 * maintain-agent-skill — create or refresh Weft's canonical, in-repository
 * Agent Skill, then independently verify the generated `weft skill` document
 * against the current Weft source before succeeding.
 *
 *   weft run maintain-agent-skill --base main --watch
 *
 * Consumers may redirect `weft skill` into Codex, Claude Code, or another
 * Agent Skills directory. This workflow owns the original inside Weft itself;
 * it never writes into a consuming repository's agent-specific directories.
 */
import { type Ctx, defineWorkflow, z } from "@techery/weft-sdk";

const Provider = z
  .enum(["claude", "codex"])
  .describe("Weft provider used for an authoring or independent verification agent step.");

const Finding = z.object({
  severity: z
    .enum(["blocking", "major", "minor"])
    .describe("Impact of the verified defect on skill correctness, portability, or safe use of Weft."),
  code: z.string().describe("Stable lowercase identifier for this class of skill defect."),
  message: z.string().describe("Concise explanation of what is wrong and what an author must correct."),
  evidence: z
    .string()
    .describe("Concrete skill and Weft source paths, commands, or contracts that prove the defect."),
  affectedFiles: z
    .array(
      z.string().describe("Repository-relative canonical skill source or test path affected by the finding."),
    )
    .describe("Canonical in-repository files that must change to resolve this finding."),
});

const Audit = z.object({
  pass: z
    .boolean()
    .describe("True only when no substantiated findings remain and every supported audience is covered."),
  summary: z
    .string()
    .describe("Evidence-based verification conclusion describing the current skill's readiness."),
  checkedSources: z
    .array(
      z
        .string()
        .describe("Repository-relative Weft source, test, or generated-skill path checked by the verifier."),
    )
    .min(1)
    .describe(
      "Current Weft implementation, test, CLI, and documentation paths inspected during verification.",
    ),
  audiences: z
    .object({
      codex: z
        .boolean()
        .describe("Whether the emitted skill is complete and actionable when installed for Codex."),
      claudeCode: z
        .boolean()
        .describe("Whether the emitted skill is complete and actionable when installed for Claude Code."),
      otherAgents: z
        .boolean()
        .describe(
          "Whether the emitted skill follows portable Agent Skills conventions without vendor-only assumptions.",
        ),
    })
    .describe("Per-audience compatibility verdicts that must all be true before the workflow can succeed."),
  findings: z
    .array(Finding)
    .describe("Substantiated correctness, freshness, or portability defects; empty only when pass is true."),
});
type Audit = z.infer<typeof Audit>;

const AuthorResult = z.object({
  disposition: z
    .enum(["created", "updated", "unchanged"])
    .describe(
      "Whether this authoring step created, modified, or confirmed the canonical skill without edits.",
    ),
  summary: z
    .string()
    .describe("Concise account of the skill work performed and the source-backed decisions made."),
  sourcePaths: z
    .array(
      z
        .string()
        .describe("Repository-relative authoritative Weft source or test path inspected by the author."),
    )
    .min(1)
    .describe("Most important current Weft source and test paths inspected while authoring the skill."),
  files: z
    .array(
      z
        .string()
        .describe("Repository-relative canonical skill source or focused test path changed by the author."),
    )
    .describe(
      "Files the author believes it changed; the workflow separately verifies the captured patch files.",
    ),
});

const SKILL_SOURCE = "packages/cli/src/commands/skill.ts";
const CLI_REGISTRATION = "packages/cli/src/main.ts";
const CLI_TEST = "packages/cli/test/cli.test.ts";
const WRITE_SCOPE = [SKILL_SOURCE, CLI_REGISTRATION, CLI_TEST] as const;

const DEFAULT_SOURCE_PATTERNS = [
  "README.md",
  "package.json",
  "docs/**/*.md",
  "examples/**/*.ts",
  "examples/**/*.md",
  ".weft/workflows/*.ts",
  "packages/*/README.md",
  "packages/sdk/src/**/*.ts",
  "packages/core/src/**/*.ts",
  "packages/host/src/**/*.ts",
  "packages/cli/src/**/*.ts",
  "packages/cli/test/**/*.ts",
  "packages/mcp/src/**/*.ts",
  "packages/daemon/src/**/*.ts",
  "packages/provider-*/src/**/*.ts",
] as const;

const CORE_SOURCES = [
  "README.md",
  "package.json",
  "packages/sdk/src/define.ts",
  "packages/sdk/src/types.ts",
  CLI_REGISTRATION,
  SKILL_SOURCE,
  "packages/host/src/weft.ts",
] as const;

const WorkflowOutput = z.object({
  disposition: z
    .enum(["created", "updated", "unchanged"])
    .describe("Final canonical-skill outcome after authoring, repair, and all required verification."),
  sourceSha: z
    .string()
    .describe("Weft Git commit inspected as the source baseline for this maintenance run."),
  relevantChanges: z
    .array(
      z
        .string()
        .describe("Git status and repository-relative path for one relevant change since the selected base."),
    )
    .describe("Changed Weft paths and statuses since the requested base that informed the skill refresh."),
  skillSource: z
    .literal(SKILL_SOURCE)
    .describe("Canonical in-repository TypeScript source that emits the original Weft Agent Skill."),
  repairRounds: z
    .number()
    .int()
    .min(0)
    .describe("Number of bounded repair-and-reverify cycles completed after the initial authoring pass."),
  verifiedBy: z
    .array(Provider)
    .describe(
      "Distinct providers that independently audited the final generated skill against current Weft.",
    ),
  summary: z.string().describe("Combined evidence-based conclusions from the final independent audits."),
});

export default defineWorkflow(
  {
    id: "maintain-weft-agent-skill",
    description:
      "Create, verify, and refresh Weft's canonical Agent Skill for Codex, Claude Code, and other coding agents.",
    input: z.object({
      base: z
        .string()
        .default("main")
        .describe("Git ref used to identify Weft changes that may require canonical skill updates."),
      sourcePatterns: z
        .array(
          z
            .string()
            .describe(
              "Repository-relative glob used to discover authoritative Weft implementation or documentation.",
            ),
        )
        .min(1)
        .default([...DEFAULT_SOURCE_PATTERNS])
        .describe(
          "Repository-relative glob patterns defining the Weft implementation and documentation evidence pool.",
        ),
      maxSourceFiles: z
        .number()
        .int()
        .min(10)
        .max(400)
        .default(40)
        .describe("Maximum prioritized source paths supplied to each authoring and verification agent."),
      maxRepairRounds: z
        .number()
        .int()
        .min(0)
        .max(3)
        .default(2)
        .describe(
          "Maximum repair-and-reverify cycles before the workflow fails closed with unresolved evidence.",
        ),
      authorWith: Provider.default("codex").describe(
        "Provider responsible for creating or repairing the canonical skill.",
      ),
      verifyWith: z
        .array(Provider)
        .min(1)
        .default(["codex"])
        .describe("Providers that independently audit the generated skill; duplicate entries are removed."),
    }),
    output: WorkflowOutput,
    defaults: { effort: "medium" },
  },
  async (ctx, { base, sourcePatterns, maxSourceFiles, maxRepairRounds, authorWith, verifyWith }) => {
    const providers = unique(verifyWith);

    ctx.phase("Inventory");
    const [{ sha: sourceSha }, changed, discovered, existing] = await Promise.all([
      ctx.git.head(),
      ctx.git.changedSince(base),
      ctx.fs.glob(sourcePatterns),
      ctx.fs.glob([SKILL_SOURCE]),
    ]);
    const relevantChanges = changed.files
      .filter((file) => isRelevantWeftPath(file.path))
      .map((file) => `${file.status} ${file.path}`)
      .sort(compare);
    const changedPaths = changed.files
      .filter((file) => file.status !== "D" && isRelevantWeftPath(file.path))
      .map((file) => file.path);
    const sourceFiles = unique([...changedPaths, ...CORE_SOURCES, ...discovered.paths]).slice(
      0,
      maxSourceFiles,
    );
    if (sourceFiles.length === 0) throw new Error("no Weft source files matched sourcePatterns");

    const initialDisposition = existing.paths.length === 0 ? "created" : "updated";
    await ctx.note({
      kind: "decision",
      text: `${initialDisposition === "created" ? "bootstrap" : "refresh"} Weft's canonical Agent Skill`,
      evidence: `${relevantChanges.length} relevant change(s) since ${base}; source ${sourceSha}`,
    });

    ctx.phase("Author");
    const authored = await ctx.agent.detailed(
      authorPrompt({ initialDisposition, sourceSha, base, sourceFiles, relevantChanges }),
      {
        schema: AuthorResult,
        provider: authorWith,
        effort: "medium",
        key: "skill:author",
        isolation: "worktree",
        write: { paths: [...WRITE_SCOPE], mode: "strict" },
        maxTurns: 20,
        timeout: "12m",
        repair: 1,
        tasks: false,
      },
    );
    let changedSkillFiles = [...authored.files];
    const authorLedger = await ctx.integrate([authored], { order: "sequential", onConflict: "fail" });
    assertIntegratedWhenChanged(
      "skill:author",
      authored.files,
      authorLedger.merged,
      authorLedger.quarantined,
    );

    let repairRounds = 0;
    let checks = await validateGeneratedSkill(ctx, repairRounds, false);
    let audits = await auditSkill(ctx, providers, {
      round: repairRounds,
      sourceSha,
      base,
      sourceFiles,
      relevantChanges,
      checkEvidence: checks.map((check) => check.evidence ?? check.status),
    });

    while ((!auditsPass(audits) || !checksPass(checks)) && repairRounds < maxRepairRounds) {
      repairRounds += 1;
      ctx.phase(`Repair ${repairRounds}`);
      const repair = await ctx.agent.detailed(
        repairPrompt({
          round: repairRounds,
          sourceSha,
          sourceFiles,
          relevantChanges,
          checkEvidence: checks.map((check) => check.evidence ?? check.status).join("\n"),
          audits,
        }),
        {
          schema: AuthorResult,
          provider: authorWith,
          effort: "medium",
          key: `skill:repair:${repairRounds}`,
          isolation: "worktree",
          write: { paths: [...WRITE_SCOPE], mode: "strict" },
          maxTurns: 16,
          timeout: "10m",
          repair: 1,
          tasks: false,
        },
      );
      changedSkillFiles = unique([...changedSkillFiles, ...repair.files]);
      const repairLedger = await ctx.integrate([repair], { order: "sequential", onConflict: "fail" });
      assertIntegratedWhenChanged(
        `skill:repair:${repairRounds}`,
        repair.files,
        repairLedger.merged,
        repairLedger.quarantined,
      );
      checks = await validateGeneratedSkill(ctx, repairRounds, false);
      audits = await auditSkill(ctx, providers, {
        round: repairRounds,
        sourceSha,
        base,
        sourceFiles,
        relevantChanges,
        checkEvidence: checks.map((check) => check.evidence ?? check.status),
      });
    }

    ctx.phase("Accept");
    const finalChecks = await validateGeneratedSkill(ctx, repairRounds, true);
    if (!checksPass(finalChecks) || !auditsPass(audits)) {
      const remaining = audits.flatMap((audit) => audit.findings.map((finding) => finding.message));
      await ctx.note({
        kind: "risk",
        text: "Weft skill verification failed closed",
        evidence: [...finalChecks.map((check) => check.evidence ?? check.status), ...remaining].join("\n"),
      });
      throw new Error(
        `skill remains unverified after ${repairRounds} repair round(s): ${remaining.join("; ") || "generated output check failed"}`,
      );
    }

    const disposition: z.infer<typeof WorkflowOutput>["disposition"] =
      initialDisposition === "created" ? "created" : changedSkillFiles.length > 0 ? "updated" : "unchanged";
    const summary = audits.map((audit) => audit.summary).join(" | ");
    await ctx.note({
      kind: "claim",
      text: `Weft's canonical Agent Skill was ${disposition} and verified for all supported agent audiences`,
      evidence: `${providers.join(", ")} against ${sourceSha}; canonical source ${SKILL_SOURCE}`,
    });
    const output: z.infer<typeof WorkflowOutput> = {
      disposition,
      sourceSha,
      relevantChanges,
      skillSource: SKILL_SOURCE,
      repairRounds,
      verifiedBy: providers,
      summary,
    };
    return output;
  },
);

interface AuditContext {
  round: number;
  sourceSha: string;
  base: string;
  sourceFiles: string[];
  relevantChanges: string[];
  checkEvidence: string[];
}

async function auditSkill(
  ctx: Ctx,
  providers: Array<z.infer<typeof Provider>>,
  audit: AuditContext,
): Promise<Audit[]> {
  ctx.phase(`Verify ${audit.round}`);
  const settled = await ctx.parallel(
    providers.map(
      (provider) => () =>
        ctx.agent(auditPrompt(audit, provider), {
          schema: Audit,
          provider,
          effort: "medium",
          key: `skill:verify:${audit.round}:${provider}`,
          maxTurns: 12,
          timeout: "8m",
          repair: 1,
          tasks: false,
        }),
    ),
  );
  const failed = settled.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new Error(
      `skill verification provider failure: ${failed
        .map((result) => (result.ok ? "" : result.error.message))
        .join("; ")}`,
    );
  }
  return settled.flatMap((result) => (result.ok ? [result.value] : []));
}

async function validateGeneratedSkill(ctx: Ctx, round: number, required: boolean) {
  const suffix = required ? ":final" : "";
  return Promise.all([
    ctx.check(`skill-output:${round}${suffix}`, {
      exec: ["node", ".weft/scripts/validate-weft-skill.mjs"],
      required,
    }),
    ctx.check(`skill-tests:${round}${suffix}`, {
      exec: ["pnpm", "vitest", "run", "packages/cli/test/cli.test.ts", "-t", "weft skill"],
      required,
      timeout: "2m",
    }),
  ]);
}

function checksPass(checks: Array<{ status: string }>): boolean {
  return checks.every((check) => check.status === "pass");
}

function auditsPass(audits: Audit[]): boolean {
  return (
    audits.length > 0 &&
    audits.every(
      (audit) =>
        audit.pass &&
        audit.findings.length === 0 &&
        audit.audiences.codex &&
        audit.audiences.claudeCode &&
        audit.audiences.otherAgents,
    )
  );
}

function authorPrompt(input: {
  initialDisposition: "created" | "updated";
  sourceSha: string;
  base: string;
  sourceFiles: string[];
  relevantChanges: string[];
}): string {
  return [
    `Create or refresh Weft's canonical Agent Skill. This is a ${input.initialDisposition} run.`,
    `Current Weft source commit: ${input.sourceSha}. Comparison base: ${input.base}.`,
    `Canonical source: ${SKILL_SOURCE}. Registration: ${CLI_REGISTRATION}. Tests: ${CLI_TEST}.`,
    "",
    "The original skill belongs inside the Weft codebase and is emitted by `weft skill` on stdout.",
    "Do not create .codex, .claude, .agents, or other consumer installation directories.",
    `If ${SKILL_SOURCE} is absent, create the command, register it in ${CLI_REGISTRATION}, and add focused tests.`,
    "If it exists, preserve useful guidance but replace stale contracts and commands. The command must remain usable",
    "before a project has .weft state and must print only a complete SKILL.md document to stdout.",
    "",
    "Inspect the current repository yourself. Treat implementation, tests, and CLI registration as authority;",
    "use README/docs as explanations that must be checked against code. Start with changed and core paths below,",
    "then inspect additional files only when a concrete contract needs evidence; do not scan every listed directory.",
    "",
    "The generated skill must:",
    "- use Agent Skills SKILL.md frontmatter with name=weft and a concise, discriminating description;",
    "- be portable to Codex, Claude Code, and other coding agents without depending on private vendor tools;",
    "- teach real Weft authoring, checking, running, resuming, replay, tasks, write/integrate, and verification semantics;",
    "- distinguish implemented behavior from roadmap/design claims and never claim publication or runtime proof without evidence;",
    "- keep essential routing in SKILL.md and include only source-backed commands and API names;",
    "- retain explicit destination examples as distribution guidance, not as files owned by this workflow;",
    "- contain no TODOs, placeholders, changelog, or duplicated generic coding advice.",
    "",
    `Relevant changes since ${input.base}:\n${lines(input.relevantChanges, "(none detected; still verify the complete current contract)")}`,
    `Priority source inventory:\n${lines(input.sourceFiles, "(none)")}`,
    "",
    "Return disposition=unchanged only after running or inspecting the generated command and confirming it is current.",
    "List only files actually changed in files, and list the most important inspected sources in sourcePaths.",
    "Keep command execution focused: run the generated-skill validator and focused CLI skill tests at most once each.",
  ].join("\n");
}

function auditPrompt(audit: AuditContext, provider: string): string {
  return [
    `Independently audit Weft's canonical Agent Skill as the ${provider} verifier. Do not trust the author summary.`,
    `Current source commit: ${audit.sourceSha}; comparison base: ${audit.base}; repair round: ${audit.round}.`,
    `Canonical source: ${SKILL_SOURCE}. Generated command: node packages/cli/bin/weft.js skill.`,
    "",
    "Run/read the generated skill and inspect current Weft implementation/tests yourself. Check every command and API",
    "contract it teaches, especially changed surfaces. Confirm stdout is a standalone SKILL.md and the command works",
    "without pre-existing .weft state. A polished document that is stale, invented, incomplete, or vendor-specific must fail.",
    "",
    "Set all audience booleans true only when the emitted original can be installed for repository-local Codex, Claude Code,",
    "and agent-neutral Agent Skills consumers. Set pass=true only when findings is empty. Every finding needs concrete",
    "source evidence and affected files. Do not report prose preferences as defects.",
    "The workflow already ran its deterministic generated-output and focused CLI tests; use that evidence below.",
    "Do not rerun broad test suites. Inspect only the source needed to prove or refute a concrete contract.",
    "",
    `Deterministic check evidence:\n${lines(audit.checkEvidence, "(no evidence recorded)")}`,
    `Relevant changes:\n${lines(audit.relevantChanges, "(none detected)")}`,
    `Priority source inventory:\n${lines(audit.sourceFiles, "(none)")}`,
  ].join("\n");
}

function repairPrompt(input: {
  round: number;
  sourceSha: string;
  sourceFiles: string[];
  relevantChanges: string[];
  checkEvidence: string;
  audits: Audit[];
}): string {
  return [
    `Repair round ${input.round} for Weft's canonical Agent Skill at source ${input.sourceSha}.`,
    `Only change the canonical command, its CLI registration when needed, and its focused tests: ${WRITE_SCOPE.join(", ")}.`,
    "Do not write consumer installation directories. Read the current files and cited Weft sources, fix every substantiated",
    "finding at its cause, and keep correct existing guidance. Do not add speculative universal rules.",
    "",
    `Deterministic check evidence:\n${clip(input.checkEvidence, 8_000)}`,
    `Independent audits:\n${clip(JSON.stringify(input.audits, null, 2), 40_000)}`,
    `Relevant changes:\n${lines(input.relevantChanges, "(none detected)")}`,
    `Priority source inventory:\n${lines(input.sourceFiles, "(none)")}`,
    "",
    "Return disposition=updated when you changed files, otherwise unchanged. List actual changed files and inspected sources.",
  ].join("\n");
}

function assertIntegratedWhenChanged(
  key: string,
  files: string[],
  merged: string[],
  quarantined: string[],
): void {
  if (files.length === 0) return;
  if (!merged.includes(key) || quarantined.includes(key)) {
    throw new Error(`${key} changed files but its patch was not integrated`);
  }
}

function isRelevantWeftPath(path: string): boolean {
  return (
    path === "README.md" ||
    path === "package.json" ||
    path === "pnpm-lock.yaml" ||
    path.startsWith("docs/") ||
    path.startsWith("examples/") ||
    path.startsWith("packages/") ||
    path.startsWith(".weft/workflows/")
  );
}

function lines(values: string[], empty: string): string {
  return values.length === 0 ? empty : values.map((value) => `- ${value}`).join("\n");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
