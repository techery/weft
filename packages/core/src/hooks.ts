import type { ExecResult, FetchResult } from "@techery/weft-sdk";

/**
 * Test seams. When a hook returns a value (not undefined), the engine journals
 * and serves it exactly as if the real side effect had run — @techery/weft-testing uses
 * this for `git:`/`exec:`/`fetch:` fixtures. Never set in production hosts.
 */
export interface TestHooks {
  git?: (op: string, args: unknown) => unknown | Promise<unknown>;
  exec?: (file: string, args: string[]) => ExecResult | undefined | Promise<ExecResult | undefined>;
  bash?: (command: string) => ExecResult | undefined | Promise<ExecResult | undefined>;
  fetch?: (url: string, method: string) => FetchResult | undefined | Promise<FetchResult | undefined>;
  env?: (name: string) => string | undefined;
}
