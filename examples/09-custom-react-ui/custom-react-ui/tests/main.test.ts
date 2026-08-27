import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("custom-react-ui exposes its durable identity", async () => {
  const source = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(source, /id:\s*["']example\.custom-react-ui["']/);
});
