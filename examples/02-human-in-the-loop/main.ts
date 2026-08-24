/**
 * Humans are steps (C5): a gate suspends the run durably, the process can exit,
 * the answer arrives from anywhere, and resume continues from that exact line.
 *
 *   npx tsx examples/02-human-in-the-loop/main.ts
 *
 * Three engine instances play three processes here:
 *   1. starts the run — it suspends on a high-risk gate and the "process" exits;
 *   2. answers the pending request against the same journal (like `weft answer`);
 *   3. resumes — every completed step is served from the journal (its mock has
 *      NO fixtures, so any provider call would throw) and the run completes.
 *
 * A second workflow shows the other side of the coin: a question with a timeout
 * and a default is answered by policy when nobody shows up.
 */
import { Engine, MemoryBlobStore, MemoryJournalStore, ProviderRegistry } from "@techery/weft-core";
import { mock } from "@techery/weft-provider-mock";
import { defineWorkflow, z } from "@techery/weft-sdk";

const journal = new MemoryJournalStore();
const blobs = new MemoryBlobStore();

function engineWith(builder = mock()) {
  const providers = new ProviderRegistry();
  providers.register(builder.provider("claude"));
  providers.register(builder.provider("codex"));
  return new Engine({ journal, blobs, providers });
}

const releaseGate = defineWorkflow(
  {
    name: "release-gate",
    description: "Propose a release, then wait for a human to approve the push",
    input: z.object({ service: z.string() }),
    output: z.object({ pushed: z.boolean(), note: z.string() }),
  },
  async (ctx, { service }) => {
    ctx.phase("Propose");
    const plan = await ctx.agent(`Summarize what shipping ${service} today entails.`, {
      schema: z.object({ summary: z.string(), risk: z.enum(["low", "medium", "high"]) }),
      key: "plan",
    });

    ctx.phase("Approve");
    // risk "high" → the default approval policy asks a person and suspends here.
    const go = await ctx.gate({
      action: `Push ${service} to production`,
      risk: "high",
      detail: plan.summary,
    });
    if (!go.approved) return { pushed: false, note: go.note ?? "denied" };
    return { pushed: true, note: go.note ?? "approved" };
  },
);

// -- process 1: start, suspend, "exit" --------------------------------------
const first = mock().on(
  { key: "plan" },
  { summary: "Ship the auth service: 3 commits, 1 migration, rollback ready.", risk: "high" },
);
const h1 = await engineWith(first).start(releaseGate, { input: { service: "auth" }, cwd: process.cwd() });
const outcome = await h1.outcome();
if (outcome.status !== "waiting_for_human") throw new Error(`expected a suspension, got ${outcome.status}`);
const request = outcome.pending[0]!;
console.log(`suspended: [${request.id}] ${request.question}`);
console.log(`           (risk ${request.risk}; detail: ${request.detail})`);

// -- process 2: answer against the journal ----------------------------------
await engineWith().answer(h1.runId, request.id, { approved: true, note: "ship it" });
console.log(`answered:  ${request.id} → approved`);
// The starting engine is still alive here (unlike a real crash), so its journal
// tailer delivers the answer and finishes the run — wait for it to release its
// ownership claim before another engine may take the run.
await h1.result;

// -- process 3: resume; zero provider calls ---------------------------------
const h2 = await engineWith().resume(h1.runId, { def: releaseGate });
console.log("resumed:  ", await h2.result);

// -- timeouts: a question nobody answers falls back to its default -----------
const pickModule = defineWorkflow(
  {
    name: "pick-module",
    description: "Ask which module to migrate first; default to auth after the timeout",
    input: z.object({}),
    output: z.object({ module: z.string(), answeredBy: z.string() }),
  },
  async (ctx) => {
    const pick = await ctx.human.ask({
      question: "Which module should we migrate first?",
      schema: z.object({ module: z.enum(["auth", "api", "billing"]) }),
      timeout: "300ms",
      onTimeout: { default: { module: "auth" } },
    });
    // the journal records WHO answered — a person, policy, or the timeout
    return { module: pick.module, answeredBy: "timeout" };
  },
);
const h3 = await engineWith().start(pickModule, { input: {}, cwd: process.cwd() });
console.log("timed out:", await h3.result);
