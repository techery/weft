import type { RunResult, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { toWireSchema } from "../../src/jsonschema.ts";
import { type CodexLike, type CodexThreadLike, createCodexProvider } from "../../../provider-codex/src/index.ts";

class FakeThread implements CodexThreadLike {
  readonly turnOptions: Array<TurnOptions | undefined> = [];
  readonly id = "t1";
  async run(_input: string, options?: TurnOptions): Promise<RunResult> {
    this.turnOptions.push(options);
    return { items: [], finalResponse: "{}", usage: null };
  }
}
class FakeCodex implements CodexLike {
  readonly threads: FakeThread[] = [];
  startThread(_options?: ThreadOptions): CodexThreadLike {
    const t = new FakeThread();
    this.threads.push(t);
    return t;
  }
  resumeThread(_id: string, _options?: ThreadOptions): CodexThreadLike {
    return this.startThread();
  }
}

async function sentToCodex(schema: Record<string, unknown>): Promise<any> {
  const codex = new FakeCodex();
  await createCodexProvider({ codex }).run(
    {
      prompt: "p",
      cwd: "/repo",
      schema,
      label: "L/agent#1",
      tools: { allowEdits: false },
      hitl: { onPermission: async () => ({ behavior: "allow" as const }), onAsk: async () => ({}) },
    } as any,
    { signal: new AbortController().signal } as any,
  );
  return codex.threads[0]?.turnOptions[0]?.outputSchema as any;
}

describe("probe: .optional() under toStrictSchema", () => {
  it("P1: plain .optional() forced into required without becoming nullable", async () => {
    const wire = toWireSchema(z.object({ id: z.string(), rationale: z.string().min(40).optional() })).json;
    console.log("P1 BEFORE:", JSON.stringify(wire));
    const out = await sentToCodex(wire);
    console.log("P1 AFTER :", JSON.stringify(out));
    const r = out.properties.rationale;
    const nullable =
      r.type === "null" ||
      (Array.isArray(r.type) && r.type.includes("null")) ||
      (Array.isArray(r.anyOf) && r.anyOf.some((b: any) => b.type === "null"));
    console.log("P1 nullable?", nullable, "required:", JSON.stringify(out.required));
    expect(nullable || !(out.required ?? []).includes("rationale")).toBe(true);
  });

  it("P2: .partial() inverted into everything-required", async () => {
    const wire = toWireSchema(z.object({ a: z.string(), b: z.number() }).partial()).json;
    console.log("P2 BEFORE:", JSON.stringify(wire));
    const out = await sentToCodex(wire);
    console.log("P2 AFTER :", JSON.stringify(out));
    expect(out.required ?? []).toEqual([]);
  });

  it("P3: recursive schema - optional child forced at every node", async () => {
    interface N { name: string; kids?: N[] }
    const Node: z.ZodType<N> = z.lazy(() => z.object({ name: z.string(), kids: z.array(Node).optional() }));
    const wire = toWireSchema(z.object({ root: Node })).json;
    console.log("P3 BEFORE:", JSON.stringify(wire));
    const out = await sentToCodex(wire);
    console.log("P3 AFTER :", JSON.stringify(out));
    const found: string[][] = [];
    const walk = (n: any): void => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (typeof n !== "object" || n === null) return;
      if (n.type === "object" && n.properties?.kids) found.push(n.required ?? []);
      Object.values(n).forEach(walk);
    };
    walk(out);
    console.log("P3 node required lists:", JSON.stringify(found));
    expect(found.every((r) => !r.includes("kids"))).toBe(true);
  });

  it("P4: real schema verdict on forced filler vs omission", async () => {
    const real = z.object({ id: z.string(), rationale: z.string().min(40).optional() });
    const forced = real.safeParse({ id: "x", rationale: "n/a" });
    console.log("P4 forced-filler ok?", forced.success, JSON.stringify(forced.error?.issues ?? []));
    console.log("P4 omitted ok?", real.safeParse({ id: "x" }).success);
    expect(forced.success).toBe(true);
  });
});
