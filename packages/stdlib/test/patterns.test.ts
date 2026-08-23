import { defineWorkflow, z } from "@weft/sdk";
import { afterAll, describe, expect, test } from "vitest";
import {
  adversarialVerify,
  adversarialVerifyResultSchema,
  CompletenessGapsSchema,
  completenessCritic,
  finalReport,
  judgePanel,
  loopUntilDry,
  multiModalSweep,
} from "../src/index.ts";
import { cleanupCwds, drops, harness, logs, runWorkflow } from "./helpers.ts";

afterAll(cleanupCwds);

const Claim = z.object({ id: z.string(), text: z.string() });
type Claim = z.infer<typeof Claim>;

describe("adversarialVerify", () => {
  test("kills a claim at 2/3 refuted and keeps one at 1/3", async () => {
    const h = harness();
    // claim 0 — two refuters agree it is wrong
    h.builder.on({ key: "refute:0:0" }, { refuted: true, reason: "the cited line does not exist" });
    h.builder.on({ key: "refute:0:1" }, { refuted: true, reason: "the guard already handles null" });
    h.builder.on({ key: "refute:0:2" }, { refuted: false, reason: "looks real to me" });
    // claim 1 — a lone dissenter is not a majority
    h.builder.on({ key: "refute:1:0" }, { refuted: true, reason: "probably a false positive" });
    h.builder.on({ key: "refute:1:1" }, { refuted: false, reason: "reproduced it locally" });
    h.builder.on({ key: "refute:1:2" }, { refuted: false, reason: "the race is genuine" });

    const def = defineWorkflow(
      {
        name: "verify",
        description: "refute claims",
        input: z.object({ claims: z.array(Claim) }),
        output: adversarialVerifyResultSchema(Claim),
      },
      async (ctx, input) =>
        adversarialVerify<Claim>(ctx, {
          claims: input.claims,
          describe: (c) => c.text,
        }),
    );

    const { output, records } = await runWorkflow(h, def, {
      claims: [
        { id: "a", text: "auth.ts:12 dereferences a null session" },
        { id: "b", text: "cache.ts:88 has a read-modify-write race" },
      ],
    });

    expect(output.survived.map((c) => c.id)).toEqual(["b"]);
    expect(output.refuted).toHaveLength(1);
    expect(output.refuted[0]!.claim.id).toBe("a");
    expect(output.refuted[0]!.reasons).toEqual([
      "the cited line does not exist",
      "the guard already handles null",
    ]);
    // 2 claims x 3 refuters, all through the engine
    expect(h.builder.calls).toHaveLength(6);
    expect(h.builder.calls[0]!.prompt).toContain("Default refuted=true if uncertain");
    expect(logs(records).join("\n")).toContain("1/2 claims survived");
  });

  test("a refuter branch that fails counts as a refute vote", async () => {
    const h = harness();
    h.builder.on({ key: "refute:0:0" }, { refuted: true, reason: "contradicted by the spec" });
    h.builder.on({ key: "refute:0:1" }, () => {
      throw new Error("provider blew up");
    });
    h.builder.on({ key: "refute:0:2" }, { refuted: false, reason: "seems fine" });

    const def = defineWorkflow(
      {
        description: "skeptical default",
        input: z.object({}),
        output: z.object({ survived: z.array(z.string()), reasons: z.array(z.string()) }),
      },
      async (ctx) => {
        const res = await adversarialVerify<string>(ctx, {
          claims: ["the migration is reversible"],
          describe: (c) => c,
        });
        return { survived: res.survived, reasons: res.refuted[0]?.reasons ?? [] };
      },
    );

    const { output } = await runWorkflow(h, def, {});
    expect(output.survived).toEqual([]);
    expect(output.reasons[0]).toBe("contradicted by the spec");
    expect(output.reasons[1]).toContain("refuter 1 failed");
  });

  test("honours refuters, keyFor, and an empty claim list", async () => {
    const h = harness();
    h.builder.on({ key: "panel/0/0" }, { refuted: false, reason: "holds" });
    h.builder.on({ key: "panel/0/1" }, { refuted: false, reason: "holds" });

    const def = defineWorkflow(
      {
        description: "custom panel",
        input: z.object({}),
        output: z.object({ survived: z.array(z.string()), empty: z.number() }),
      },
      async (ctx) => {
        const none = await adversarialVerify<string>(ctx, { claims: [], describe: (c) => c });
        const res = await adversarialVerify<string>(ctx, {
          claims: ["ok"],
          describe: (c) => c,
          refuters: 2,
          keyFor: (i, r) => `panel/${i}/${r}`,
        });
        return { survived: res.survived, empty: none.survived.length + none.refuted.length };
      },
    );

    const { output } = await runWorkflow(h, def, {});
    expect(output.empty).toBe(0);
    expect(output.survived).toEqual(["ok"]);
    expect(h.builder.calls.map((c) => c.key)).toEqual(["panel/0/0", "panel/0/1"]);
  });
});

const Design = z.object({ approach: z.string(), risk: z.string() });

describe("judgePanel", () => {
  test("picks the attempt with the most best-votes", async () => {
    const h = harness();
    h.builder.on({ key: "attempt:0" }, { approach: "single writer lock", risk: "throughput" });
    h.builder.on({ key: "attempt:1" }, { approach: "versioned entries", risk: "memory" });
    h.builder.on({ key: "attempt:2" }, { approach: "ttl only", risk: "staleness" });
    h.builder.on({ key: "judge:0" }, { scores: [5, 9, 4], best: 1, rationale: "versioning wins" });
    h.builder.on({ key: "judge:1" }, { scores: [6, 8, 3], best: 1, rationale: "same" });
    h.builder.on({ key: "judge:2" }, { scores: [4, 7, 9], best: 2, rationale: "ttl is simplest" });

    const def = defineWorkflow(
      {
        description: "judge designs",
        input: z.object({}),
        output: z.object({ winner: Design, attempts: z.array(Design), scores: z.array(z.number()) }),
      },
      async (ctx) =>
        judgePanel(ctx, {
          task: "Design cache invalidation",
          angles: ["favor simplicity", "favor correctness", "favor throughput"],
          attemptSchema: Design,
        }),
    );

    const { output, records } = await runWorkflow(h, def, {});
    expect(output.attempts).toHaveLength(3);
    expect(output.winner.approach).toBe("versioned entries");
    expect(output.scores).toEqual([5, 8, 16 / 3]);
    // three attempts + one judge per attempt
    expect(h.builder.calls).toHaveLength(6);
    const judgePrompt = h.builder.calls.find((c) => c.key === "judge:0")!.prompt;
    expect(judgePrompt).toContain("--- ATTEMPT 0 ---");
    expect(judgePrompt).toContain("versioned entries");
    expect(logs(records).join("\n")).toContain("attempt 1 won with 2/3 best-votes");
  });

  test("breaks a best-vote tie on mean score and namespaces keys by prefix", async () => {
    const h = harness();
    h.builder.on({ key: "round2:attempt:0" }, { approach: "a", risk: "x" });
    h.builder.on({ key: "round2:attempt:1" }, { approach: "b", risk: "y" });
    h.builder.on({ key: "round2:judge:0" }, { scores: [6, 5], best: 0, rationale: "a" });
    h.builder.on({ key: "round2:judge:1" }, { scores: [9, 6], best: 1, rationale: "b" });

    const def = defineWorkflow(
      {
        description: "tie break",
        input: z.object({}),
        output: z.object({ winner: z.string(), scores: z.array(z.number()) }),
      },
      async (ctx) => {
        const res = await judgePanel(ctx, {
          task: "pick one",
          angles: ["one", "two"],
          attemptSchema: Design,
          keyPrefix: "round2",
        });
        return { winner: res.winner.approach, scores: res.scores };
      },
    );

    const { output } = await runWorkflow(h, def, {});
    // 1 best-vote each; attempt 0's mean (7.5) beats attempt 1's (5.5)
    expect(output.scores).toEqual([7.5, 5.5]);
    expect(output.winner).toBe("a");
  });

  test("drops a failed attempt and judges only the survivors", async () => {
    const h = harness();
    h.builder.on({ key: "attempt:0" }, { approach: "kept", risk: "none" });
    h.builder.on({ key: "attempt:1" }, () => {
      throw new Error("attempt exploded");
    });
    h.builder.on({ key: "judge:0" }, { scores: [7], best: 0, rationale: "only option" });

    const def = defineWorkflow(
      {
        description: "partial panel",
        input: z.object({}),
        output: z.object({ winner: z.string(), attempts: z.number() }),
      },
      async (ctx) => {
        const res = await judgePanel(ctx, {
          task: "pick one",
          angles: ["one", "two"],
          attemptSchema: Design,
        });
        return { winner: res.winner.approach, attempts: res.attempts.length };
      },
    );

    const { output, records } = await runWorkflow(h, def, {});
    expect(output).toEqual({ winner: "kept", attempts: 1 });
    expect(drops(records).join("\n")).toContain("attempt exploded");
  });
});

const Item = z.object({ id: z.string() });

describe("loopUntilDry", () => {
  test("dedupes overlapping rounds and stops after two dry rounds", async () => {
    const h = harness();
    h.builder.on({ key: "find:1" }, { items: [{ id: "a" }, { id: "b" }] });
    h.builder.on({ key: "find:2" }, { items: [{ id: "b" }, { id: "c" }] });
    h.builder.on({ key: "find:3" }, { items: [] });
    h.builder.on({ key: "find:4" }, { items: [] });

    const def = defineWorkflow(
      {
        description: "sweep until dry",
        input: z.object({}),
        output: z.object({ ids: z.array(z.string()), rounds: z.number() }),
      },
      async (ctx) => {
        let rounds = 0;
        const found = await loopUntilDry(ctx, {
          find: async (round) => {
            rounds = round;
            const out = await ctx.agent(`Round ${round}: find leftovers`, {
              schema: z.object({ items: z.array(Item) }),
              key: `find:${round}`,
            });
            return out.items;
          },
          keyOf: (item) => item.id,
        });
        return { ids: found.map((i) => i.id), rounds };
      },
    );

    const { output, records } = await runWorkflow(h, def, {});
    expect(output.ids).toEqual(["a", "b", "c"]);
    expect(output.rounds).toBe(4);
    // round 5 has no fixture: reaching it would fail the run
    expect(h.builder.calls.map((c) => c.key)).toEqual(["find:1", "find:2", "find:3", "find:4"]);
    expect(logs(records).join("\n")).toContain("round 2 returned 2, 1 new");
    expect(logs(records).join("\n")).toContain("2 dry round(s) in a row");
  });

  test("a single dry round does not end a loop whose streak was broken", async () => {
    const h = harness();
    h.builder.on({ key: "find:1" }, { items: [{ id: "a" }] });
    h.builder.on({ key: "find:2" }, { items: [] });
    h.builder.on({ key: "find:3" }, { items: [{ id: "d" }] });
    h.builder.on({ key: "find:4" }, { items: [] });
    h.builder.on({ key: "find:5" }, { items: [] });

    const def = defineWorkflow(
      { description: "streak reset", input: z.object({}), output: z.object({ ids: z.array(z.string()) }) },
      async (ctx) => {
        const found = await loopUntilDry(ctx, {
          find: async (round) =>
            (
              await ctx.agent(`Round ${round}`, {
                schema: z.object({ items: z.array(Item) }),
                key: `find:${round}`,
              })
            ).items,
          keyOf: (item) => item.id,
        });
        return { ids: found.map((i) => i.id) };
      },
    );

    const { output } = await runWorkflow(h, def, {});
    expect(output.ids).toEqual(["a", "d"]);
    expect(h.builder.calls).toHaveLength(5);
  });

  test("maxRounds caps a loop that never runs dry", async () => {
    const h = harness();
    h.builder.on({ key: "find:*" }, (req) => ({ items: [{ id: req.key! }] }));

    const def = defineWorkflow(
      { description: "capped", input: z.object({}), output: z.object({ count: z.number() }) },
      async (ctx) => {
        const found = await loopUntilDry(ctx, {
          find: async (round) =>
            (
              await ctx.agent(`Round ${round}`, {
                schema: z.object({ items: z.array(Item) }),
                key: `find:${round}`,
              })
            ).items,
          keyOf: (item) => item.id,
          maxRounds: 3,
        });
        return { count: found.length };
      },
    );

    const { output, records } = await runWorkflow(h, def, {});
    expect(output.count).toBe(3);
    expect(logs(records).join("\n")).toContain("hit the ceiling of 3 round(s)");
  });
});

const Observations = z.object({ observations: z.array(z.string()) });

describe("multiModalSweep", () => {
  test("drops a failing mode, names it in the log, and returns the rest", async () => {
    const h = harness();
    h.builder.on({ key: "sweep:security" }, { observations: ["session fixation on login"] });
    h.builder.on({ key: "sweep:perf" }, () => {
      throw new Error("timed out reading traces");
    });
    h.builder.on({ key: "sweep:ux" }, { observations: ["error copy leaks internals"] });

    const def = defineWorkflow(
      {
        description: "sweep the checkout flow",
        input: z.object({}),
        output: z.object({ modes: z.array(z.string()), first: z.string() }),
      },
      async (ctx) => {
        const views = await multiModalSweep(ctx, {
          subject: "the checkout flow",
          modes: [
            { name: "security", prompt: "Where can a hostile client force a bad state?" },
            { name: "perf", prompt: "Where does latency come from under load?" },
            { name: "ux", prompt: "Where does the flow confuse a first-time buyer?" },
          ],
          schema: Observations,
        });
        return { modes: views.map((v) => v.mode), first: views[0]?.result.observations[0] ?? "" };
      },
    );

    const { output, records } = await runWorkflow(h, def, {});
    expect(output.modes).toEqual(["security", "ux"]);
    expect(output.first).toBe("session fixation on login");
    expect(logs(records).join("\n")).toContain("dropped 1/3 mode(s): perf");
    expect(drops(records).join("\n")).toContain("timed out reading traces");
  });

  test("keeps every mode when they all succeed, and prefixes keys", async () => {
    const h = harness();
    h.builder.on({ key: "pass2:sweep:*" }, (req) => ({ observations: [req.key!] }));

    const def = defineWorkflow(
      { description: "clean sweep", input: z.object({}), output: z.object({ keys: z.array(z.string()) }) },
      async (ctx) => {
        const views = await multiModalSweep(ctx, {
          subject: "the parser",
          modes: [
            { name: "grammar", prompt: "Which inputs are ambiguous?" },
            { name: "errors", prompt: "Which failures produce a useless message?" },
          ],
          schema: Observations,
          keyPrefix: "pass2",
        });
        return { keys: views.flatMap((v) => v.result.observations) };
      },
    );

    const { output } = await runWorkflow(h, def, {});
    expect(output.keys).toEqual(["pass2:sweep:grammar", "pass2:sweep:errors"]);
    const grammar = h.builder.calls.find((c) => c.key === "pass2:sweep:grammar")!;
    expect(grammar.prompt).toContain("LENS (grammar)");
    expect(grammar.prompt).toContain("errors");
  });
});

describe("completenessCritic", () => {
  test("returns typed gaps for what the run never covered", async () => {
    const h = harness();
    h.builder.on(
      { key: "completeness" },
      {
        missing: [
          { what: "no performance sweep was run", why: "the brief asked for latency risk" },
          { what: "the rate-limit claim is unverified", why: "no refuter ever checked it" },
        ],
      },
    );

    const def = defineWorkflow(
      {
        description: "critique completeness",
        input: z.object({}),
        output: CompletenessGapsSchema,
      },
      async (ctx) =>
        completenessCritic(ctx, {
          produced: "# Audit\n\nFound 3 security issues.",
          instructions: "Audit the checkout flow for security and latency risk.",
        }),
    );

    const { output, records } = await runWorkflow(h, def, {});
    expect(output.missing).toHaveLength(2);
    expect(output.missing[0]!.what).toBe("no performance sweep was run");
    expect(output.missing[1]!.why).toBe("no refuter ever checked it");
    const prompt = h.builder.calls[0]!.prompt;
    expect(prompt).toContain("Audit the checkout flow for security and latency risk.");
    expect(prompt).toContain("review only what is ABSENT");
    expect(logs(records).join("\n")).toContain("2 gap(s) reported");
  });

  test("works without instructions and honours a custom key", async () => {
    const h = harness();
    h.builder.on({ key: "gaps:final" }, { missing: [] });

    const def = defineWorkflow(
      { description: "no brief", input: z.object({}), output: CompletenessGapsSchema },
      async (ctx) => completenessCritic(ctx, { produced: "a draft", key: "gaps:final" }),
    );

    const { output } = await runWorkflow(h, def, {});
    expect(output.missing).toEqual([]);
    expect(h.builder.calls[0]!.key).toBe("gaps:final");
    expect(h.builder.calls[0]!.prompt).toContain("No brief was recorded");
  });
});

describe("finalReport", () => {
  test("assembles deterministic markdown with no agent", async () => {
    const h = harness();
    const def = defineWorkflow(
      { description: "report", input: z.object({}), output: z.object({ md: z.string(), same: z.boolean() }) },
      async (ctx) => {
        const opts = {
          title: "  Checkout audit  ",
          sections: [
            { heading: "Findings", body: "- session fixation on login\n- rate limit is advisory only" },
            { heading: "Refuted", body: "  the cache race (2/3 refuters)  " },
            { heading: "Open questions", body: "   " },
          ],
        };
        const md = finalReport(ctx, opts);
        return { md, same: md === finalReport(ctx, opts) };
      },
    );

    const { output } = await runWorkflow(h, def, {});
    expect(output.same).toBe(true);
    expect(h.builder.calls).toHaveLength(0);
    expect(output.md).toBe(
      [
        "# Checkout audit",
        "",
        "## Findings",
        "",
        "- session fixation on login",
        "- rate limit is advisory only",
        "",
        "## Refuted",
        "",
        "the cache race (2/3 refuters)",
        "",
        "## Open questions",
        "",
      ].join("\n"),
    );
  });
});
