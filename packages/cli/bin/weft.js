#!/usr/bin/env node
/**
 * The `weft` entry point. The CLI ships as TypeScript, so tsx is registered first and
 * everything below it — this package and any workflow helper it loads — is plain ESM.
 */
import { register } from "tsx/esm/api";

// `weft report <run> | head` closes the pipe under us; that is the reader's business, not
// a crash. Anything else on these streams is still a real error.
const ignoreEpipe = (error) => {
  if (error?.code !== "EPIPE") throw error;
};
process.stdout.on("error", ignoreEpipe);
process.stderr.on("error", ignoreEpipe);

register();

const { run } = await import(new URL("../src/main.ts", import.meta.url).href);
await run(process.argv.slice(2));
