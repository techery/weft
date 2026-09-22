import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  Engine,
  MemoryBlobStore,
  MemoryJournalStore,
  type OperationBindings,
  ProviderRegistry,
} from "@techery/weft-core";
import { defineOperation, defineWorkflow, z } from "@techery/weft-sdk";
import { diagnosticRepair } from "@techery/weft-stdlib";
import { buildTestHooks, type MockAgentBuilder, mock, runWorkflow } from "@techery/weft-testing";
import reviewWorkflow from "../.weft/workflows/review/main.ts";
import { reviewOneFile } from "../examples/11-composable-workflow/composable-review/lib/procedures.ts";

const CaseId = z.enum([
  "review-distinct-findings",
  "review-worker-failure",
  "review-bounded-fanout",
  "diagnostic-repair",
  "diagnostic-exhaustion",
  "procedure-restart",
  "operation-reconciliation",
  "missing-effect-fixture",
]);
const Metrics = z.record(z.string(), z.union([z.number(), z.boolean(), z.string()]));
const Cases = z.object({
  version: z.literal(1),
  cases: z.array(z.object({ id: CaseId, input: z.unknown(), expected: Metrics })).min(1),
});
export type EvaluationCase = z.infer<typeof Cases>["cases"][number];
export type EvaluationMetrics = z.infer<typeof Metrics>;
export interface EvaluationResult {
  id: EvaluationCase["id"];
  passed: boolean;
  expected: EvaluationMetrics;
  observed: EvaluationMetrics;
  error?: string;
}
export interface EvaluationReport {
  version: 1;
  mode: "deterministic-mock";
  passed: boolean;
  totals: { cases: number; passed: number; failed: number };
  results: EvaluationResult[];
}

export async function loadEvaluationCases(): Promise<EvaluationCase[]> {
  const data = Cases.parse(
    JSON.parse(await readFile(new URL("./evaluate-workflows.cases.json", import.meta.url), "utf8")),
  );
  if (new Set(data.cases.map(({ id }) => id)).size !== data.cases.length)
    throw new Error("Evaluation case ids must be unique");
  return data.cases;
}

const finding = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  claim: z.string(),
  evidence: z.string(),
});
const changed = (files: string[]) => ({
  changedSince: { files: files.map((path) => ({ path, status: "M" })) },
});
const calls = (provider: MockAgentBuilder, prefix: string) =>
  provider.calls.filter(({ key }) => key?.startsWith(prefix)).length;

async function scratch<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "weft-evaluation-"));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function memoryEngine(
  journal: MemoryJournalStore,
  blobs: MemoryBlobStore,
  provider: MockAgentBuilder,
  operations?: OperationBindings,
): Engine {
  return new Engine({
    journal,
    blobs,
    providers: new ProviderRegistry()
      .register(provider.provider("claude"))
      .register(provider.provider("codex")),
    config: { limits: { concurrency: 32 } },
    testHooks: buildTestHooks({ fixtureMode: "strict" }),
    ...(operations ? { operations } : {}),
  });
}

async function evaluateCase(entry: EvaluationCase): Promise<EvaluationMetrics> {
  switch (entry.id) {
    case "review-distinct-findings": {
      const input = z.object({ file: z.string(), findings: z.array(finding) }).parse(entry.input);
      const provider = mock()
        .on({ key: "review:*" }, { findings: input.findings })
        .on({ key: "refute:*" }, { real: true, reason: "Fixture confirms failure" });
      const { output } = await runWorkflow(reviewWorkflow, {
        input: {},
        fixtureMode: "strict",
        git: changed([input.file]),
        provider,
      });
      return {
        confirmed: output.confirmed.length,
        reviewCalls: calls(provider, "review:"),
        refuteCalls: calls(provider, "refute:"),
      };
    }
    case "review-worker-failure": {
      const input = z.object({ file: z.string() }).parse(entry.input);
      const provider = mock().on({ key: "review:*" }, () => {
        throw new Error("Fixture worker unavailable");
      });
      let rejected = false;
      try {
        await runWorkflow(reviewWorkflow, {
          input: {},
          fixtureMode: "strict",
          git: changed([input.file]),
          provider,
        });
      } catch (error) {
        rejected = String(error).includes("Fixture worker unavailable");
      }
      return { rejected, reviewCalls: calls(provider, "review:"), refuteCalls: calls(provider, "refute:") };
    }
    case "review-bounded-fanout": {
      const input = z
        .object({
          files: z.number().int().positive(),
          hostConcurrency: z.number().int().positive(),
          expectedBatchSize: z.number().int().positive(),
        })
        .parse(entry.input);
      if (input.files % input.expectedBatchSize !== 0)
        throw new Error("Fanout case files must fill complete barrier batches");
      let active = 0;
      let maxActive = 0;
      let waiting: Array<() => void> = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const release = () => {
        const pending = waiting;
        waiting = [];
        for (const resume of pending) resume();
      };
      // The barrier makes peak admission deterministic without timing-based measurements.
      // A bounded watchdog turns a broken admission implementation into a failed case.
      timer = setTimeout(() => {
        timedOut = true;
        release();
      }, 5_000);
      const provider = mock().on({ key: "review:*" }, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        if (!timedOut)
          await new Promise<void>((resume) => {
            waiting.push(resume);
            if (waiting.length === input.expectedBatchSize) release();
          });
        active--;
        return { findings: [] };
      });
      try {
        const { output } = await runWorkflow(reviewWorkflow, {
          input: {},
          fixtureMode: "strict",
          provider,
          config: { limits: { concurrency: input.hostConcurrency } },
          git: changed(Array.from({ length: input.files }, (_, i) => `file-${i}.ts`)),
        });
        if (timedOut) throw new Error("Fanout barrier timed out before the expected batch was admitted");
        return { reviewCalls: provider.calls.length, maxActive, confirmed: output.confirmed.length };
      } finally {
        clearTimeout(timer);
        release();
      }
    }
    case "diagnostic-repair":
    case "diagnostic-exhaustion": {
      const input = z
        .object({ maxRepairs: z.number().int().nonnegative(), passAfter: z.number().int().nonnegative() })
        .parse(entry.input);
      const definition = defineWorkflow(
        {
          name: "evaluation-diagnostic",
          description: "Evaluate the shipped repair helper",
          input: z.object({}),
          output: z.object({ accepted: z.boolean(), repairRounds: z.number() }),
        },
        async (ctx) => {
          const result = await diagnosticRepair({
            maxRepairs: input.maxRepairs,
            diagnose: (round) =>
              ctx.agent(`Inspect repair round ${round}`, {
                key: `diagnose:${round}`,
                schema: z.object({ passed: z.boolean() }),
              }),
            accepted: (diagnostic) => diagnostic.passed,
            repair: async (_diagnostic, round) => {
              await ctx.agent(`Repair round ${round}`, {
                key: `repair:${round}`,
                schema: z.object({ repaired: z.boolean() }),
              });
            },
          });
          return { accepted: result.result.passed, repairRounds: result.repairs };
        },
      );
      const provider = mock()
        .on({ key: "diagnose:*" }, ({ key }) => ({ passed: Number(key?.split(":")[1]) >= input.passAfter }))
        .on({ key: "repair:*" }, { repaired: true });
      const { output } = await runWorkflow(definition, { input: {}, fixtureMode: "strict", provider });
      return {
        ...output,
        diagnosticCalls: calls(provider, "diagnose:"),
        repairCalls: calls(provider, "repair:"),
      };
    }
    case "procedure-restart":
      return scratch(async (cwd) => {
        let bodyEntries = 0;
        const instrumented: typeof reviewOneFile = {
          ...reviewOneFile,
          run: (ctx, input) => {
            bodyEntries++;
            return reviewOneFile.run(ctx, input);
          },
        };
        const definition = defineWorkflow(
          {
            name: "evaluation-procedure",
            description: "Restart a shipped review procedure",
            input: z.object({}),
            output: z.array(z.unknown()),
          },
          (ctx) =>
            ctx.procedure(
              instrumented,
              { objective: "Review", file: { path: "a.ts", content: "export const a = 1" }, conventions: [] },
              { key: "review" },
            ),
        );
        const journal = new MemoryJournalStore();
        const blobs = new MemoryBlobStore();
        const initialProvider = mock().on({ key: "review/review" }, { findings: [] });
        const first = await memoryEngine(journal, blobs, initialProvider).start(definition, {
          input: {},
          cwd,
        });
        const output = await first.result;
        const resumeProvider = mock();
        const resumed = await memoryEngine(journal, blobs, resumeProvider).resume(first.runId, {
          def: definition,
        });
        const resumedOutput = await resumed.result;
        return {
          bodyEntries,
          initialProviderCalls: initialProvider.calls.length,
          resumeProviderCalls: resumeProvider.calls.length,
          sameOutput: isDeepStrictEqual(output, resumedOutput),
        };
      });
    case "operation-reconciliation":
      return scratch(async (cwd) => {
        let executeCalls = 0;
        let reconcileCalls = 0;
        let remoteReceipt: { receipt: string } | undefined;
        const operation = defineOperation({
          name: "Evaluation operation",
          revision: "v1",
          binding: "evaluation.receipt",
          risk: "low",
          input: z.object({}),
          output: z.object({ receipt: z.string() }),
        });
        const operations: OperationBindings = {
          "evaluation.receipt": {
            risk: "low",
            execute: async () => {
              executeCalls++;
              remoteReceipt = { receipt: "mock-receipt" };
              throw new Error("Simulated lost acknowledgement after apply");
            },
            reconcile: async () => {
              reconcileCalls++;
              return remoteReceipt ? { status: "applied", output: remoteReceipt } : { status: "not_applied" };
            },
          },
        };
        const definition = defineWorkflow(
          {
            name: "evaluation-reconciliation",
            description: "Reconcile simulated external success",
            input: z.object({}),
            output: z.object({ reconciled: z.boolean(), receipt: z.string() }),
          },
          async (ctx) => {
            const result = await ctx.operation(operation, {}, { key: "apply" });
            return { reconciled: result.reconciled, receipt: result.value.receipt };
          },
        );
        const journal = new MemoryJournalStore();
        const blobs = new MemoryBlobStore();
        const first = await memoryEngine(journal, blobs, mock(), operations).start(definition, {
          input: {},
          cwd,
        });
        let initialFailure = "none";
        try {
          await first.result;
        } catch (error) {
          initialFailure =
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "unexpected";
        }
        const resumed = await memoryEngine(journal, blobs, mock(), operations).resume(first.runId, {
          def: definition,
        });
        const result = (await resumed.result) as { reconciled: boolean; receipt: string };
        return { initialFailure, executeCalls, reconcileCalls, ...result };
      });
    case "missing-effect-fixture": {
      const definition = defineWorkflow(
        {
          name: "evaluation-fixtures",
          description: "Refuse a missing effect fixture",
          input: z.object({}),
          output: z.unknown(),
        },
        (ctx) => ctx.exec("weft-evaluation-must-not-execute", [], { key: "probe" }),
      );
      const provider = mock();
      let rejectedBeforeEffect = false;
      try {
        await runWorkflow(definition, { input: {}, fixtureMode: "strict", provider });
      } catch (error) {
        rejectedBeforeEffect = /missing exec weft-evaluation-must-not-execute fixture \(strict mode\)/.test(
          String(error),
        );
      }
      return { rejectedBeforeEffect, providerCalls: provider.calls.length };
    }
  }
}

export async function evaluateWorkflows(cases?: EvaluationCase[]): Promise<EvaluationReport> {
  const selected = cases ?? (await loadEvaluationCases());
  if (selected.length === 0) throw new Error("Evaluation must select at least one case");
  const results: EvaluationResult[] = [];
  for (const entry of selected) {
    try {
      const observed = await evaluateCase(entry);
      results.push({
        id: entry.id,
        passed: isDeepStrictEqual(observed, entry.expected),
        expected: entry.expected,
        observed,
      });
    } catch (error) {
      results.push({
        id: entry.id,
        passed: false,
        expected: entry.expected,
        observed: {},
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    version: 1,
    mode: "deterministic-mock",
    passed: passed === results.length,
    totals: { cases: results.length, passed, failed: results.length - passed },
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await evaluateWorkflows();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}
