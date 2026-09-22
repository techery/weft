/** A deterministic finding identity that survives line movement and whitespace edits.
 * Prefer a domain-owned fingerprint when semantic consolidation is available.
 */
export function findingKey(finding: { file: string; claim: string }): string {
  const identity = [
    finding.file.replaceAll("\\", "/").replace(/^\.\//, ""),
    finding.claim.trim().replace(/\s+/g, " "),
  ];
  // An injective encoding avoids hash collisions and needs no host-only imports.
  return identity.map(encodeURIComponent).join(":");
}

/** Collapse the same claim from overlapping review scopes before scheduling effects. */
export function uniqueFindings<T extends { file: string; claim: string }>(findings: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const finding of findings) {
    const key = findingKey(finding);
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()];
}

/** Keep each file's edits together. Integrate each group before starting the next
 * when tests or support files can overlap across groups.
 */
export function groupFindingsByFile<T extends { file: string }>(
  findings: readonly T[],
): Array<{ file: string; findings: T[] }> {
  const groups = new Map<string, T[]>();
  for (const finding of findings) {
    const file = finding.file.replaceAll("\\", "/").replace(/^\.\//, "");
    const group = groups.get(file) ?? [];
    group.push(finding);
    groups.set(file, group);
  }
  return [...groups].map(([file, grouped]) => ({ file, findings: grouped }));
}

/** Fail closed if a writer changed files without an accepted integration receipt. */
export function assertIntegratedWhenChanged(
  key: string,
  files: readonly string[],
  merged: readonly string[],
  quarantined: readonly string[],
): void {
  if (files.length > 0 && (!merged.includes(key) || quarantined.includes(key))) {
    throw new Error(`${key} changed files but its patch was not integrated`);
  }
}

export interface DiagnosticRepairOptions<T> {
  maxRepairs: number;
  diagnose(round: number): Promise<T>;
  accepted(result: T): boolean;
  repair(result: T, round: number): Promise<void>;
}

/** Diagnostic attempts remain ordinary visible effects. The caller performs its
 * final required gate after this bounded loop; failed attempts are not gates.
 */
export async function diagnosticRepair<T>(
  options: DiagnosticRepairOptions<T>,
): Promise<{ result: T; repairs: number }> {
  if (!Number.isSafeInteger(options.maxRepairs) || options.maxRepairs < 0) {
    throw new Error("maxRepairs must be a non-negative safe integer");
  }
  let repairs = 0;
  let result = await options.diagnose(repairs);
  while (!options.accepted(result) && repairs < options.maxRepairs) {
    repairs += 1;
    await options.repair(result, repairs);
    result = await options.diagnose(repairs);
  }
  return { result, repairs };
}
