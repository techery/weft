/**
 * A read-only code review that turns only human-approved, independently verified
 * findings into durable workflow tasks.
 */
import { defineWorkflow, type WorkflowTaskSummary, z } from "@techery/weft-sdk";

const FindingCategory = z.enum(["correctness", "accessibility", "security", "performance", "test-quality"]);

const RawFinding = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  severity: z.enum(["blocking", "major", "minor"]),
  category: FindingCategory,
  symbol: z.string().describe("nearest stable function, component, atom, or module name"),
  claim: z.string().describe("one sentence describing the observable failure"),
  evidence: z.string().describe("the source lines and execution path that demonstrate it"),
});
const Finding = RawFinding.extend({
  fingerprint: z
    .string()
    .regex(/^[a-z0-9_./|:-]+$/)
    .describe("stable file|symbol|failure-mode identity; never include a line number"),
  sourceClaims: z.number().int().min(1),
});
type Finding = z.infer<typeof Finding>;

const ConsolidatedFindings = z.object({
  findings: z.array(Finding).superRefine((findings, refinement) => {
    const fingerprints = new Set<string>();
    for (const [index, finding] of findings.entries()) {
      if (fingerprints.has(finding.fingerprint)) {
        refinement.addIssue({
          code: "custom",
          path: [index, "fingerprint"],
          message: "fingerprint must be unique after consolidation",
        });
      }
      fingerprints.add(finding.fingerprint);
    }
  }),
});

const ConfirmedFinding = Finding.extend({ verification: z.string() });
type ConfirmedFinding = z.infer<typeof ConfirmedFinding>;

const Verdict = z.object({ real: z.boolean(), reason: z.string() });
const ReviewTaskExtensions = z.object({
  kind: z.literal("code-review-finding"),
  fingerprint: z.string(),
  category: FindingCategory,
  reviewSeverity: z.enum(["blocking", "major", "minor"]),
  firstSeenRun: z.string(),
  firstSeenSha: z.string(),
  lastSeenRun: z.string(),
  lastSeenSha: z.string(),
  disposition: z.enum(["accepted", "duplicate", "wont-fix"]),
});
type ReviewTaskExtensions = z.infer<typeof ReviewTaskExtensions>;

const RANK: Record<Finding["severity"], number> = { blocking: 3, major: 2, minor: 1 };
const PRIORITY = { blocking: "critical", major: "high", minor: "medium" } as const;
const ACCEPTANCE = [
  "A regression test or deterministic reproduction demonstrates the failure",
  "The implementation fixes the underlying cause",
  "Typecheck, tests, and build pass",
  "An independent reviewer confirms the issue no longer reproduces",
] as const;

export default defineWorkflow(
  {
    id: "example.task-backed-code-review",
    name: "task-backed-code-review",
    description: "Review source and persist only human-approved findings as deduplicated workflow tasks.",
    input: z.object({
      base: z.string().optional(),
      include: z.array(z.string()).default(["src/**/*.ts", "src/**/*.tsx"]),
      maxFiles: z.number().int().min(1).max(50).default(8),
      reviewWith: z.string().default("codex"),
      refuteWith: z.string().default("claude"),
    }),
    output: z.object({
      reviewed: z.array(z.string()),
      confirmed: z.array(ConfirmedFinding),
      refuted: z.number().int(),
      recorded: z.number().int(),
    }),
    tasks: { extensions: ReviewTaskExtensions, semanticRevision: "code-review-v1" },
  },
  async (ctx, { base, include, maxFiles, reviewWith, refuteWith }) => {
    if (reviewWith === refuteWith) {
      throw new Error("reviewWith and refuteWith must name different providers");
    }

    ctx.phase("Scope");
    const { sha: sourceSha } = await ctx.git.head();
    const { paths } = await ctx.fs.glob(include);
    let candidates = [...paths].sort(compare);
    if (base !== undefined) {
      const { files } = await ctx.git.changedSince(base);
      const changed = new Set(files.filter((file) => file.status !== "D").map((file) => file.path));
      candidates = candidates.filter((path) => changed.has(path));
    }
    const reviewed = candidates.slice(0, maxFiles);
    if (reviewed.length === 0) {
      await ctx.note({
        kind: "decision",
        text: "nothing in scope to review",
        evidence: include.join(", "),
      });
      return { reviewed, confirmed: [], refuted: 0, recorded: 0 };
    }

    ctx.phase("Review");
    const reviewResults = await ctx.parallel(
      reviewed.map((file) =>
        ctx.agent(
          [
            `Review ${file} for real correctness, security, performance, accessibility, or test defects.`,
            "Read the file and its dependencies. Cite file:line and quote concrete evidence.",
            "Assign the primary owning file, category, and nearest stable symbol.",
            "The injected tasks are advisory history: verify the current source independently.",
            "Do not report style or refactoring preferences; an empty list is valid.",
          ].join("\n"),
          {
            schema: z.object({ findings: z.array(RawFinding) }),
            key: `review:${file}`,
            provider: reviewWith,
            tasks: {
              mode: "read",
              relatedFiles: [file],
              tags: ["code-review"],
              statuses: ["todo", "in_progress", "blocked"],
              limit: 20,
            },
          },
        ),
      ),
    );
    const reviewFailures = reviewResults.filter((result) => !result.ok);
    if (reviewFailures.length > 0) {
      throw new Error(
        `code review failed for ${reviewFailures.length} of ${reviewed.length} file(s): ${reviewFailures
          .map((result) => (result.ok ? "" : result.error.message))
          .join("; ")}`,
      );
    }
    const reviews = reviewResults.flatMap((result) => (result.ok ? [result.value] : []));
    const rawFindings = reviews.flatMap((review) => review.findings);

    ctx.phase("Consolidate");
    const findings =
      rawFindings.length === 0
        ? []
        : (
            await ctx.agent(
              [
                "Consolidate these claims into unique underlying defects.",
                "Merge paraphrases only when they describe the same failure in the same stable symbol.",
                "Keep distinct failure modes separate. Preserve the strongest evidence and severity.",
                "Assign fingerprint=file|symbol|failure-mode with lowercase ASCII words and punctuation;",
                "never include a line number. sourceClaims is the number of merged raw claims.",
                "",
                clip(JSON.stringify(rawFindings, null, 2), 120_000),
              ].join("\n"),
              {
                schema: ConsolidatedFindings,
                key: "consolidate",
                provider: reviewWith,
                effort: "high",
                tasks: false,
              },
            )
          ).findings;

    ctx.phase("Refute");
    const verdictResults = await ctx.parallel(
      findings.map((finding) =>
        ctx.agent(
          [
            `Try to refute this claim about ${finding.file}:${finding.line}.`,
            `Claim: ${finding.claim}`,
            `Evidence: ${finding.evidence}`,
            "Read the code yourself. Set real=false unless a concrete input reaches the wrong result.",
          ].join("\n"),
          {
            schema: Verdict,
            provider: refuteWith,
            key: `refute:${finding.fingerprint}`,
            tasks: false,
          },
        ),
      ),
    );
    const verdictFailures = verdictResults.filter((result) => !result.ok);
    if (verdictFailures.length > 0) {
      throw new Error(
        `independent refutation failed for ${verdictFailures.length} of ${findings.length} finding(s): ${verdictFailures
          .map((result) => (result.ok ? "" : result.error.message))
          .join("; ")}`,
      );
    }
    const verdicts = verdictResults.flatMap((result, index) =>
      result.ok ? [{ finding: findings[index]!, verdict: result.value }] : [],
    );
    const confirmed = verdicts.flatMap(({ finding, verdict }) =>
      verdict.real ? [{ ...finding, verification: verdict.reason }] : [],
    );
    const ranked = [...confirmed].sort(
      (a, b) => RANK[b.severity] - RANK[a.severity] || compare(a.file, b.file) || a.line - b.line,
    );

    ctx.phase("Decide");
    if (ranked.length === 0) {
      await ctx.note({
        kind: "decision",
        text: `reviewed ${reviewed.length} file(s); nothing survived refutation`,
        evidence: `${rawFindings.length} raw claim(s) consolidated to ${findings.length}`,
      });
      return { reviewed, confirmed: [], refuted: findings.length, recorded: 0 };
    }
    const fingerprints = ranked.map((finding) => finding.fingerprint) as [string, ...string[]];
    const decision = await ctx.human.review({
      artifact: report(reviewed, ranked, rawFindings.length, findings.length),
      question: `${ranked.length} unique finding(s) survived refutation — which fingerprints should become tasks?`,
      schema: z.object({
        record: z
          .array(z.enum(fingerprints))
          .superRefine((selected, refinement) => {
            if (new Set(selected).size !== selected.length) {
              refinement.addIssue({ code: "custom", message: "each fingerprint may be selected once" });
            }
          })
          .describe("fingerprints to create or refresh as workflow tasks"),
        comment: z.string().optional().describe("context appended to each selected task occurrence"),
      }),
    });

    ctx.phase("Record");
    const requested = new Set(decision.record);
    const known = new Set(ranked.map((finding) => finding.fingerprint));
    const unknown = [...requested].filter((fingerprint) => !known.has(fingerprint));
    if (unknown.length > 0) {
      throw new Error(`decision selected unknown finding fingerprint(s): ${unknown.join(", ")}`);
    }
    const kept = ranked.filter((finding) => requested.has(finding.fingerprint));
    const existingTasks: WorkflowTaskSummary<ReviewTaskExtensions>[] = [];
    for (const [batchIndex, batch] of chunks(kept, 100).entries()) {
      const observed = await ctx.tasks.observe(
        { dedupeKeys: batch.map((finding) => finding.fingerprint), limit: 100 },
        { key: `record:existing:${batchIndex}` },
      );
      existingTasks.push(...observed.tasks);
    }
    const byFingerprint = new Map(
      existingTasks.flatMap((task) => (task.dedupeKey ? [[task.dedupeKey, task] as const] : [])),
    );

    for (const [index, finding] of kept.entries()) {
      const prior = byFingerprint.get(finding.fingerprint);
      const priorExtensions = ReviewTaskExtensions.safeParse(prior?.extensions);
      const firstSeen = priorExtensions.success
        ? {
            firstSeenRun: priorExtensions.data.firstSeenRun,
            firstSeenSha: priorExtensions.data.firstSeenSha,
          }
        : { firstSeenRun: ctx.run.id, firstSeenSha: sourceSha };
      const extensions: ReviewTaskExtensions = {
        kind: "code-review-finding",
        fingerprint: finding.fingerprint,
        category: finding.category,
        reviewSeverity: finding.severity,
        ...firstSeen,
        lastSeenRun: ctx.run.id,
        lastSeenSha: sourceSha,
        disposition: "accepted",
      };
      const reopening = prior?.status === "done" || prior?.status === "cancelled";
      const description = [
        finding.claim,
        "",
        `Evidence at ${finding.file}:${finding.line}:`,
        finding.evidence,
        "",
        `Independent verification: ${finding.verification}`,
      ].join("\n");
      const occurrence = [
        `Observed in run ${ctx.run.id} at ${sourceSha} (${finding.file}:${finding.line}).`,
        `Consolidated from ${finding.sourceClaims} claim(s).`,
        ...(decision.comment ? [`Human context: ${decision.comment}`] : []),
      ].join(" ");
      await ctx.tasks.upsert(
        finding.fingerprint,
        {
          create: {
            title: finding.claim,
            description,
            status: "todo",
            priority: PRIORITY[finding.severity],
            tags: ["code-review", finding.category, finding.severity],
            relatedFiles: [finding.file],
            acceptanceCriteria: [...ACCEPTANCE],
            extensions,
          },
          update: {
            title: finding.claim,
            description,
            ...(reopening ? { status: "todo" as const } : {}),
            priority: PRIORITY[finding.severity],
            tags: ["code-review", finding.category, finding.severity],
            relatedFiles: [finding.file],
            ...(reopening ? { acceptanceCriteria: [...ACCEPTANCE], resetAcceptance: true } : {}),
            extensions,
          },
          note: occurrence,
        },
        { key: `record:${index}:${finding.fingerprint}` },
      );
    }
    await ctx.note({
      kind: "decision",
      text: `recorded ${kept.length} of ${ranked.length} confirmed finding(s) as workflow tasks`,
      ...(decision.comment !== undefined ? { evidence: decision.comment } : {}),
    });
    return {
      reviewed,
      confirmed: ranked,
      refuted: findings.length - ranked.length,
      recorded: kept.length,
    };
  },
);

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

function chunks<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

function report(
  reviewed: string[],
  confirmed: ConfirmedFinding[],
  rawClaims: number,
  consolidatedClaims: number,
): string {
  const lines = [
    "# Code review",
    "",
    `${confirmed.length} of ${consolidatedClaims} unique finding(s) survived refutation, ` +
      `consolidated from ${rawClaims} raw claim(s) across ${reviewed.length} file(s).`,
    "",
  ];
  for (const severity of ["blocking", "major", "minor"] as const) {
    const group = confirmed.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    lines.push(`## ${severity} · ${group.length}`, "");
    for (const finding of group) {
      lines.push(
        `### ${finding.file}:${finding.line}`,
        "",
        `Fingerprint: \`${finding.fingerprint}\` · ${finding.category} · ${finding.sourceClaims} source claim(s)`,
        "",
        finding.claim,
        "",
        "```",
        finding.evidence,
        "```",
        "",
        `Independent verification: ${finding.verification}`,
        "",
      );
    }
  }
  lines.push("## Files reviewed", "", ...reviewed.map((file) => `- ${file}`), "");
  return lines.join("\n");
}
