import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineWorkflow, z } from "@techery/weft-sdk";
import { afterAll, expect, test } from "vitest";
import { cleanupRepos, reopen, tempRepo, testEngine } from "./helpers.ts";

afterAll(cleanupRepos);

test("an offline file-review edit authenticates and changes only the owned workspace", async () => {
  const source = "# Original plan\n";
  const cwd = await tempRepo({ "plan.md": source });
  const def = defineWorkflow(
    {
      name: "owned-review",
      description: "review",
      input: z.object({}),
      output: z.object({ approved: z.boolean() }),
      workspace: { branch: "weft/owned-review" },
    },
    (ctx) =>
      ctx.human.review({
        subject: { kind: "file", path: "plan.md", mode: "edit" },
        schema: z.object({ approved: z.boolean() }),
      }),
  );
  const t = testEngine({ config: { approvalPolicy: { tiers: { high: "auto" } } } });
  const run = await t.engine.start(def, { input: {}, cwd });
  void run.result.catch(() => undefined);
  const outcome = await run.outcome();
  if (outcome.status !== "waiting_for_human") throw new Error("expected review");
  const request = outcome.pending[0]!;
  if (request.reviewSubject?.kind !== "file") throw new Error("expected file");
  const workspace = (await t.engine.state(run.runId)).workspace!;
  await t.engine.shutdown();
  const resumed = reopen(t);
  await resumed.engine.answer(
    run.runId,
    request.id,
    { approved: true },
    {
      reviewEdit: { content: "# Approved plan\n", beforeSha256: request.reviewSubject.sha256 },
    },
  );
  expect(await readFile(join(cwd, "plan.md"), "utf8")).toBe(source);
  expect(await readFile(join(workspace.path, "plan.md"), "utf8")).toBe("# Approved plan\n");
});
