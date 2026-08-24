/**
 * Write-scope checking. A write step declares the paths it may touch; this splits
 * the files it actually touched so the engine can warn or quarantine.
 */

import type { WriteScope } from "@techery/weft-sdk";
import picomatch from "picomatch";

/** Partition files into in-scope / out-of-scope for a declared write scope (picomatch, dot: true). */
export function checkScope(
  files: string[],
  scope: Pick<WriteScope, "paths" | "also">,
): { inScope: string[]; outOfScope: string[] } {
  const patterns = [...(scope.paths ?? []), ...(scope.also ?? [])];
  // An empty scope matches nothing: everything touched is out of scope.
  const matches = patterns.length > 0 ? picomatch(patterns, { dot: true }) : () => false;
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const file of files) {
    (matches(file) ? inScope : outOfScope).push(file);
  }
  return { inScope, outOfScope };
}
