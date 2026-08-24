/**
 * Write-scope checking. A write step declares the paths it may touch; this splits
 * the files it actually touched so the engine can warn or quarantine.
 */

import type { WriteScope } from "@techery/weft-sdk";
import picomatch from "picomatch";

/**
 * Paths and patterns are compared in NFC.
 *
 * macOS hands back decomposed filenames (`café.txt`) while a workflow author types
 * the composed form (`café.txt`) — the same name to every human and to git, but not to a
 * string comparison. Left alone, an agent's legitimate edit reads as out of scope on the
 * platform most of them run on.
 */
function nfc(value: string): string {
  return value.normalize("NFC");
}

/**
 * picomatch compiles `*` and `**` to character classes that do not cross a newline, so a
 * filename containing one never matches its own directory's pattern. Git allows those
 * bytes, and a fail-closed miss here quarantines work the agent was told to do. Newlines
 * are mapped to a character the wildcards do accept; patterns cannot contain one, so
 * nothing else changes meaning.
 */
const NEWLINE_STANDIN = "";

function matchable(path: string): string {
  return nfc(path).replace(/[\n\r]/g, NEWLINE_STANDIN);
}

/**
 * Partition files into in-scope / out-of-scope for a declared write scope.
 *
 * Inclusions and exclusions are evaluated separately rather than handed to picomatch as
 * one list, because picomatch's array semantics are not what a scope means: given
 * `["src/**", "!src/secret.ts"]` it reports `src/secret.ts` as a MATCH, so an author who
 * wrote the natural "this directory but not that file" got no exclusion at all. Given
 * only `["!secrets/**"]` it matches every other path in the repository, turning what
 * reads as a narrow scope into write access to the whole tree. Both fail open, which is
 * the wrong direction for a boundary.
 *
 * A file is in scope when it matches at least one inclusion and no exclusion. A scope
 * with no inclusions matches nothing, exactly like an empty one.
 */
export function checkScope(
  files: string[],
  scope: Pick<WriteScope, "paths" | "also">,
): { inScope: string[]; outOfScope: string[] } {
  const patterns = [...(scope.paths ?? []), ...(scope.also ?? [])];
  const include: string[] = [];
  const exclude: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) exclude.push(nfc(pattern.slice(1)));
    else include.push(nfc(pattern));
  }

  // An empty scope matches nothing: everything touched is out of scope.
  const included = include.length > 0 ? picomatch(include, { dot: true }) : () => false;
  const excluded = exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false;

  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const file of files) {
    const candidate = matchable(file);
    (included(candidate) && !excluded(candidate) ? inScope : outOfScope).push(file);
  }
  return { inScope, outOfScope };
}
