import { MemoryJournalStore } from "@techery/weft-core";
import type { Weft } from "@techery/weft-host";
import { StepError } from "@techery/weft-sdk";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { registerAttentionRoutes } from "../src/api/attention.ts";

test("attention endpoint includes failed runs and clears only after a receipt resolves uncertainty", async () => {
  const journal = new MemoryJournalStore();
  await journal.append("r1", [
    { type: "run.created", runId: "r1", workflow: { name: "publish" }, input: {}, cwd: "/repo", depth: 0 },
    { type: "operation.intent", requestId: "request", binding: "pr", digest: "d", key: "pr", input: {} },
    { type: "operation.unknown", requestId: "request", binding: "pr", detail: "Unconfirmed remote result" },
    { type: "run.failed", error: new StepError("recovery_required", "unknown").serialize() },
  ]);
  const weft = { engine: { journal, list: () => journal.list() } } as unknown as Weft;
  const app = new Hono();
  registerAttentionRoutes(app, weft);
  const response = await app.request("http://localhost/api/attention");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { attention: unknown[]; unreadable: unknown[] };
  expect(body.attention).toEqual([
    expect.objectContaining({
      runId: "r1",
      workflow: "publish",
      attention: expect.objectContaining({ requestId: "request", title: "Recovery required" }),
    }),
  ]);
  expect(body.unreadable).toEqual([]);
  await journal.append("r1", [
    { type: "run.status", status: "executing" },
    {
      type: "operation.receipt",
      requestId: "request",
      binding: "pr",
      digest: "d",
      output: { url: "https://example.test/1" },
      reconciled: true,
    },
    { type: "run.completed", output: {} },
  ]);
  const resolved = (await (await app.request("http://localhost/api/attention")).json()) as {
    attention: unknown[];
  };
  expect(resolved.attention).toEqual([]);
});
