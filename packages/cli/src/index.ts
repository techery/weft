/**
 * @weft/cli — the `weft` command line. The package entry exists so another host can embed
 * the program (`buildProgram(io)`) or drive it end to end (`run(argv)`); `bin/weft.js` is
 * a five-line wrapper over exactly this.
 */

export type { CliIo } from "./io.ts";
export { buildProgram, consoleIo, run } from "./main.ts";
