/**
 * `weft diff <a> <b>` — what changed between two runs, matched by step key. Comparing runs
 * is only possible because every step output is a schema-validated value rather than prose
 * (C2): "the verdict flipped" is a field-level fact here, not a reading exercise.
 */
import { Command } from "commander";
import pc from "picocolors";
import { openWeft } from "../context.ts";
import { jsonLine } from "../format.ts";
import { type CliIo, say } from "../io.ts";
import { keyedOutputs } from "../runio.ts";

export function diffCommand(io: CliIo): Command {
  return new Command("diff")
    .description("compare two runs' step outputs, matched by key")
    .argument("<a>", "first run id")
    .argument("<b>", "second run id")
    .action(async (a: string, b: string, _opts: unknown, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const [left, right] = await Promise.all([keyedOutputs(weft, a), keyedOutputs(weft, b)]);
        const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
        let differences = 0;

        for (const key of keys) {
          const inA = left.has(key);
          const inB = right.has(key);
          if (inA && !inB) {
            differences++;
            say(io, `${pc.red("-")} ${key} ${pc.dim(`only in ${a}`)}`, `    ${jsonLine(left.get(key))}`);
          } else if (!inA && inB) {
            differences++;
            say(io, `${pc.green("+")} ${key} ${pc.dim(`only in ${b}`)}`, `    ${jsonLine(right.get(key))}`);
          } else {
            const changes = shallowDiff(left.get(key), right.get(key));
            if (changes.length === 0) continue;
            differences++;
            say(io, `${pc.yellow("~")} ${key}`, ...changes.map((line) => `    ${line}`));
          }
        }
        if (differences === 0) io.out(pc.dim(`no differences across ${keys.length} matched step(s)`));
        else io.out(pc.dim(`${differences} of ${keys.length} step(s) differ`));
      } finally {
        await weft.close();
      }
    });
}

/**
 * One level deep: field-by-field for two objects, whole-value otherwise. Deeper is what
 * `weft explain` is for — a diff that recurses forever stops being scannable.
 */
export function shallowDiff(a: unknown, b: unknown): string[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    const lines: string[] = [];
    for (const key of keys) {
      const leftHas = key in a;
      const rightHas = key in b;
      const left = a[key];
      const right = b[key];
      // Presence is part of the value: an ABSENT field and an explicit null are
      // different outputs and must show as a change.
      if (leftHas === rightHas && JSON.stringify(left) === JSON.stringify(right)) continue;
      lines.push(
        `${key}: ${pc.red(leftHas ? jsonLine(left, 36) : "(absent)")} ${pc.dim("→")} ${pc.green(rightHas ? jsonLine(right, 36) : "(absent)")}`,
      );
    }
    return lines;
  }
  if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return [];
  return [`${pc.red(jsonLine(a, 36))} ${pc.dim("→")} ${pc.green(jsonLine(b, 36))}`];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
