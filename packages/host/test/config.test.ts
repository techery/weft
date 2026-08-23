import { afterAll, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../src/index.ts";
import { cleanupRoots, tempRoot, write } from "./helpers.ts";

afterAll(cleanupRoots);

describe("loadConfig", () => {
  it("returns {} when there is no .weft/config.json", async () => {
    const root = await tempRoot();
    await expect(loadConfig(root)).resolves.toEqual({});
  });

  it("returns {} when there is no .weft directory at all", async () => {
    await expect(loadConfig("/nonexistent-weft-root-xyz")).resolves.toEqual({});
  });

  it("reads engine config plus the host's workflows block", async () => {
    const root = await tempRoot();
    await write(
      root,
      ".weft/config.json",
      JSON.stringify({
        defaults: { provider: "codex", model: "gpt-5", effort: "high" },
        providers: {
          claude: { concurrency: 2, prices: { "claude-opus-5": { inputPer1M: 5, outputPer1M: 25 } } },
        },
        approvalPolicy: { tiers: { medium: "auto" }, actions: { "git.push *": "ask" } },
        fetchAllow: ["api.github.com"],
        limits: { concurrency: 3, maxTurns: 12 },
        workflows: { dir: "flows", allowBare: ["lodash"] },
      }),
    );

    const config = await loadConfig(root);

    expect(config.defaults).toEqual({ provider: "codex", model: "gpt-5", effort: "high" });
    expect(config.providers?.["claude"]?.concurrency).toBe(2);
    expect(config.approvalPolicy?.tiers?.medium).toBe("auto");
    expect(config.fetchAllow).toEqual(["api.github.com"]);
    expect(config.limits?.maxTurns).toBe(12);
    expect(config.workflows).toEqual({ dir: "flows", allowBare: ["lodash"] });
  });

  it("keeps unknown top-level keys instead of rejecting them", async () => {
    const root = await tempRoot();
    await write(root, ".weft/config.json", JSON.stringify({ ui: { port: 4781 } }));
    const config = (await loadConfig(root)) as { ui?: { port?: number } };
    expect(config.ui?.port).toBe(4781);
  });

  it("throws an error naming the file on a JSON syntax error", async () => {
    const root = await tempRoot();
    await write(root, ".weft/config.json", '{ "defaults": { "provider": "claude", } ');
    await expect(loadConfig(root)).rejects.toThrow(configPath(root));
    await expect(loadConfig(root)).rejects.toThrow(/not valid JSON/);
  });

  it("throws an error naming the file and the field on a bad value", async () => {
    const root = await tempRoot();
    await write(root, ".weft/config.json", JSON.stringify({ limits: { maxTurns: "many" } }));
    const error = await loadConfig(root).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(configPath(root));
    expect(error?.message).toContain("limits.maxTurns");
  });

  it("rejects a config file that is not a JSON object", async () => {
    const root = await tempRoot();
    await write(root, ".weft/config.json", "[1, 2, 3]");
    await expect(loadConfig(root)).rejects.toThrow(/must contain a JSON object/);
  });
});
