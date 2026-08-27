/**
 * Edit-tolerant replay (C3, C4): resume re-executes the code and serves completed
 * steps from the journal. Rewording one prompt re-runs exactly that step; a
 * `replay --dry` shows the plan before any model is called.
 *
 *   npx tsx examples/04-resume-and-replay/main.ts
 */
import { Engine, MemoryBlobStore, MemoryJournalStore, ProviderRegistry } from "@techery/weft-core";
import { type MockAgentBuilder, mock } from "@techery/weft-provider-mock";
import { defineWorkflow, z } from "@techery/weft-sdk";

const journal = new MemoryJournalStore();
const blobs = new MemoryBlobStore();

function engineWith(builder: MockAgentBuilder) {
  const providers = new ProviderRegistry();
  providers.register(builder.provider("claude"));
  providers.register(builder.provider("codex"));
  return new Engine({ journal, blobs, providers });
}

// The workflow takes the middle prompt as a parameter so we can "edit the script"
// between resumes the way you would edit a .weft/workflows/*/main.ts entry.
const mkDef = (analyzePrompt: string) =>
  defineWorkflow(
    {
      name: "triage",
      description: "Three steps and a journaled random draw, then a human gate",
      input: z.object({}),
      output: z.object({ tags: z.array(z.string()), draw: z.number() }),
    },
    async (ctx) => {
      const scan = await ctx.agent("Scan the repository layout.", {
        schema: z.object({ tag: z.string() }),
        key: "scan",
      });
      const analyze = await ctx.agent(analyzePrompt, {
        schema: z.object({ tag: z.string() }),
        key: "analyze",
      });
      const summarize = await ctx.agent("Summarize the findings.", {
        schema: z.object({ tag: z.string() }),
        key: "summarize",
      });
      const draw = await ctx.random(); // journaled: identical on every resume
      await ctx.human.approve({ action: "File the triage report?" });
      return { tags: [scan.tag, analyze.tag, summarize.tag], draw };
    },
  );

const tagBack = (builder: MockAgentBuilder) => builder.on({ key: "*" }, (req) => ({ tag: `${req.key}@v1` }));

// -- run until the human gate, then "the process dies" -----------------------
const b1 = tagBack(mock());
const v1 = mkDef("Analyze the hot paths.");
const h1 = await engineWith(b1).start(v1, { input: {}, cwd: process.cwd() });
const o1 = await h1.outcome();
if (o1.status !== "waiting_for_human") throw new Error("expected suspension");
console.log(
  `run ${h1.runId}: ${b1.calls.length} provider calls, then suspended on "${o1.pending[0]!.question}"`,
);

await engineWith(mock()).answer(h1.runId, o1.pending[0]!.id, { approved: true });
// The starting engine is still alive here (unlike a real crash), so its journal
// tailer delivers the answer and finishes the run — wait for it to release its
// ownership claim before another engine may take the run.
await h1.result;

// -- resume unchanged: everything serves, zero provider calls ----------------
const b2 = mock(); // no fixtures — any provider call would throw
const h2 = await engineWith(b2).resume(h1.runId, { def: v1 });
const out1 = (await h2.result) as { draw: number };
console.log(`resume (unchanged): ${b2.calls.length} provider calls, draw=${out1.draw.toFixed(6)}`);

// -- "edit the script": reword the middle prompt -----------------------------
const v2 = mkDef("Analyze the hot paths AND the allocation profile.");

// replay --dry first: what would a resume reuse?
const dry = await engineWith(mock()).replayDry(h1.runId, { def: v2 });
console.log(
  `replay --dry:   hits=${dry.hits} salvaged=${dry.salvaged} diverged=[${dry.diverged.map((d) => d.key).join(", ")}]`,
);

// the real resume re-runs exactly the reworded step
const b3 = mock().on({ key: "analyze" }, { tag: "analyze@v2" });
const h3 = await engineWith(b3).resume(h1.runId, { def: v2 });
const out2 = (await h3.result) as { tags: string[]; draw: number };
console.log(
  `resume (edited): ${b3.calls.length} provider call → tags=[${out2.tags.join(", ")}], draw=${out2.draw.toFixed(6)}`,
);
console.log(`determinism:     draw identical across resumes → ${out1.draw === out2.draw}`);
