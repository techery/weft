#!/usr/bin/env node
/**
 * The `weft` entry point, in both the shapes this package exists in.
 *
 * A published install resolves `exports` to `dist/`, because `publishConfig` rewrote it at
 * pack time, and every dependency alongside it was packed the same way — so the compiled
 * ESM loads under plain node. In a checkout `exports` still points at `src/*.ts` for every
 * workspace package, so the sources are the only coherent thing to load, and tsx is
 * registered to read them. Asking the manifest is exact; probing for `dist/` is not, since
 * `pnpm build` leaves one behind in a checkout whose dependencies are still TypeScript.
 */
import { readFileSync } from "node:fs";

// `weft report <run> | head` closes the pipe under us; that is the reader's business, not
// a crash. Anything else on these streams is still a real error.
const ignoreEpipe = (error) => {
  if (error?.code !== "EPIPE") throw error;
};
process.stdout.on("error", ignoreEpipe);
process.stderr.on("error", ignoreEpipe);

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const published = String(manifest.exports?.["."]?.default ?? "").startsWith("./dist/");

if (!published) {
  const { register } = await import("tsx/esm/api");
  register();
}

const entry = new URL(published ? "../dist/main.js" : "../src/main.ts", import.meta.url);
const { run } = await import(entry.href);
await run(process.argv.slice(2));
