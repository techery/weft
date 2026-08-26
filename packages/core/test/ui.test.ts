import { createHash } from "node:crypto";
import type { JournalRecord } from "@techery/weft-core";
import {
  type CompiledUiCatalog,
  type DisplayUiView,
  defineWorkflow,
  type InputUiView,
  z,
} from "@techery/weft-sdk";
import { afterAll, describe, expect, test } from "vitest";
import { cleanupRepos, reopen, tempDir, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);

const assetKey = "a".repeat(64);

function catalog(revision = "1", mode: "display" | "input" = "display"): CompiledUiCatalog {
  const code = `console.log(${JSON.stringify({ revision, mode })})`;
  const hash = createHash("sha256").update(code).digest("hex");
  return {
    buildHash: createHash("sha256").update(`${revision}:${mode}:${hash}`).digest("hex"),
    assets: [{ assetKey, id: "test-view", revision, mode, protocol: 1, code, hash }],
  };
}

async function records(
  journal: { read(runId: string): AsyncIterable<JournalRecord> },
  runId: string,
): Promise<JournalRecord[]> {
  const out: JournalRecord[] = [];
  for await (const record of journal.read(runId)) out.push(record);
  return out;
}

describe("custom workflow UI", () => {
  test("ctx.ui.render journals a replayable presentation with durable bundle and props", async () => {
    const t = testEngine();
    const view = { kind: "weft.ui-view", assetKey } as unknown as DisplayUiView<{ message: string }>;
    const def = defineWorkflow(
      { description: "ui", input: z.object({}), output: z.object({ ok: z.boolean() }) },
      async (ctx) => {
        await ctx.ui.render({ key: "summary", slot: "main", view, props: { message: "hello" } });
        return { ok: true };
      },
    );
    const cwd = await tempDir();
    const handle = await t.engine.start(def, { input: {}, cwd, uiCatalog: catalog() });
    await expect(handle.result).resolves.toEqual({ ok: true });

    const state = await t.engine.state(handle.runId);
    const uiStep = state.steps.find((step) => step.kind === "ui");
    expect(uiStep?.presentation).toMatchObject({
      asset: { id: "test-view", revision: "1", protocol: 1 },
      props: { inline: { message: "hello" } },
      mode: "display",
      slot: "main",
    });
    expect(await t.blobs.getText(uiStep!.presentation!.asset.bundleRef.$blob)).toContain("console.log");

    const second = reopen(t);
    const resumed = await second.engine.resume(handle.runId, { def, uiCatalog: catalog() });
    await expect(resumed.result).resolves.toEqual({ ok: true });
    const completions = (await records(t.journal, handle.runId)).filter(
      (record) => record.ev.type === "step.completed" && record.ev.presentation !== undefined,
    );
    expect(completions).toHaveLength(1);
  });

  test("input views stage durable UI while the schema remains authoritative", async () => {
    const t = testEngine();
    const Answer = z.object({ choice: z.enum(["a", "b"]) });
    const view = { kind: "weft.ui-view", assetKey } as unknown as InputUiView<
      { choices: string[] },
      z.input<typeof Answer>
    >;
    const def = defineWorkflow(
      { description: "input-ui", input: z.object({}), output: Answer },
      async (ctx) =>
        ctx.human.ask({
          key: "choice",
          question: "Choose",
          schema: Answer,
          ui: { view, props: { choices: ["a", "b"] } },
        }),
    );
    const handle = await t.engine.start(def, {
      input: {},
      cwd: await tempDir(),
      uiCatalog: catalog("1", "input"),
    });
    const waiting = await handle.outcome();
    if (waiting.status !== "waiting_for_human") throw new Error("expected human request");
    expect(waiting.pending[0]?.ui).toMatchObject({
      asset: { id: "test-view", revision: "1" },
      mode: "input",
    });
    await expect(t.engine.answer(handle.runId, waiting.pending[0]!.id, { choice: "nope" })).rejects.toThrow(
      /does not match/,
    );
    await t.engine.answer(handle.runId, waiting.pending[0]!.id, { choice: "a" });
    await expect(handle.result).resolves.toEqual({ choice: "a" });
  });

  test("a changed input-view revision supersedes the old same-key request", async () => {
    const first = testEngine();
    const Answer = z.object({ choice: z.string() });
    const view = { kind: "weft.ui-view", assetKey } as unknown as InputUiView<
      Record<string, never>,
      z.input<typeof Answer>
    >;
    const def = defineWorkflow(
      { description: "supersede", input: z.object({}), output: Answer },
      async (ctx) =>
        ctx.human.ask({ key: "choice", question: "Choose", schema: Answer, ui: { view, props: {} } }),
    );
    const handle = await first.engine.start(def, {
      input: {},
      cwd: await tempDir(),
      uiCatalog: catalog("1", "input"),
    });
    const waiting = await handle.outcome();
    if (waiting.status !== "waiting_for_human") throw new Error("expected human request");
    const oldId = waiting.pending[0]!.id;
    await first.engine.shutdown();

    const second = reopen(first);
    const resumed = await second.engine.resume(handle.runId, { def, uiCatalog: catalog("2", "input") });
    const next = await resumed.outcome();
    if (next.status !== "waiting_for_human") throw new Error("expected replacement request");
    expect(next.pending[0]?.id).not.toBe(oldId);
    const state = await second.engine.state(handle.runId);
    expect(state.humans.find((human) => human.id === oldId)?.status).toBe("superseded");
    await expect(second.engine.answer(handle.runId, oldId, { choice: "old" })).rejects.toThrow(/superseded/);
    await second.engine.answer(handle.runId, next.pending[0]!.id, { choice: "new" });
    await expect(resumed.result).resolves.toEqual({ choice: "new" });
  });

  test("UI slots never key-reuse a presentation when its props change", async () => {
    const t = testEngine();
    const view = { kind: "weft.ui-view", assetKey } as unknown as DisplayUiView<{ message: string }>;
    const workflow = (message: string) =>
      defineWorkflow(
        { description: "ui-reuse", input: z.object({}), output: z.object({ ok: z.boolean() }) },
        async (ctx) => {
          await ctx.ui.render({ key: "summary", view, props: { message } });
          return { ok: true };
        },
      );
    const handle = await t.engine.start(workflow("first"), {
      input: {},
      cwd: await tempDir(),
      uiCatalog: catalog(),
      reuse: "key",
    });
    await expect(handle.result).resolves.toEqual({ ok: true });

    const second = reopen(t);
    const resumed = await second.engine.resume(handle.runId, {
      def: workflow("second"),
      uiCatalog: catalog(),
      reuse: "key",
    });
    await expect(resumed.result).resolves.toEqual({ ok: true });
    const completions = (await records(t.journal, handle.runId)).filter(
      (record) => record.ev.type === "step.completed" && record.ev.presentation !== undefined,
    );
    expect(completions).toHaveLength(2);
    expect(completions.at(-1)?.ev).toMatchObject({
      presentation: { props: { inline: { message: "second" } } },
    });
  });
});
