/**
 * Input checking shared by every host that starts a run.
 *
 * `weft run review --basse x` and `POST /api/runs {"input":{"basse":"x"}}` are the same
 * mistake arriving through different doors, and a check that lives in one host is a check
 * the other silently lacks — which is exactly what happened: the CLI refused a typo'd
 * field while the HTTP surface accepted it, started an agent run against the wrong input,
 * and reported success.
 */
import type { WorkflowDefinition } from "@techery/weft-sdk";
import { validateSchema } from "@techery/weft-sdk";

/**
 * Refuse an input field the workflow's schema silently drops.
 *
 * Dynamic flags accept any `--name value`, and a Zod object strips what it does not know,
 * so `weft run review --basse release-2.0` used to review `main` and say nothing. Every
 * flag a person types is a decision about what this run costs; a typo has to be a
 * refusal, not a default.
 *
 * The test is what the schema DID, not what its shape lists. An open schema —
 * `.passthrough()`, `.loose()`, `.catchall(…)` — has a `shape` too, and reading that
 * would reject the very fields such a workflow exists to receive. Validating and asking
 * what the schema did with each key answers the real question for any Standard Schema,
 * without reaching into one vendor's internals.
 *
 * "Absent from the output" is not yet "dropped", which is why each candidate is put back
 * to the schema twice. A transform consumes the names it reads —
 * `.transform(({ base }) => ({ baseRef: base }))` documents `--base` and returns a
 * different key — so a key-list comparison alone would refuse the workflow's own flag.
 * The question is whether the schema READ the key, and two probes answer it:
 *
 *   - remove it, and
 *   - replace its value with one no declared field would accept.
 *
 * A probe that fails validation, or lands on a different value, is the schema saying it
 * read that key. Only a key that changes nothing under BOTH is treated as unknown.
 * Neither probe suffices alone: removing `--base main` from a field that defaults to
 * `"main"` reproduces the same output and would condemn a perfectly good flag, while a
 * field the transform reads only for its presence survives the substitution and not the
 * removal.
 */
export async function rejectUnknownInput(
  input: Record<string, unknown>,
  def: WorkflowDefinition,
  name: string,
): Promise<void> {
  const keys = Object.keys(input);
  if (keys.length === 0) return;
  const checked = await validateSchema(def.meta.input, input);
  // A schema that REJECTS the input says so in its own words, and the engine surfaces
  // that in a moment. Nothing to add here.
  if (!checked.ok) return;
  const out = checked.value;
  // A transform can return anything; only a plain object compares key-for-key.
  if (typeof out !== "object" || out === null || Array.isArray(out)) return;
  const kept = out as Record<string, unknown>;
  const dropped: string[] = [];
  for (const key of keys) {
    // hasOwn, not `in`: `in` walks the prototype chain, so `--constructor` and
    // `--to-string` would read as kept on any ordinary object literal.
    if (Object.hasOwn(kept, key)) continue;
    const without = { ...input };
    delete without[key];
    const substituted = { ...input, [key]: PROBE };
    const probes = await Promise.all([
      validateSchema(def.meta.input, without),
      validateSchema(def.meta.input, substituted),
    ]);
    if (probes.every((probe) => probe.ok && sameValue(probe.value, out))) dropped.push(key);
  }
  if (dropped.length === 0) return;

  // The shape, where there is one, is used only for the hint.
  const shape = (def.meta.input as { shape?: Record<string, unknown> } | undefined)?.shape;
  const declared = shape && typeof shape === "object" ? Object.keys(shape).sort() : [];
  throw new Error(
    `${name} has no input field ${dropped.map((k) => `"${k}"`).join(", ")}` +
      (declared.length > 0
        ? ` — it takes ${declared.map((k) => `--${kebabCase(k)}`).join(", ")}`
        : " — it takes no input"),
  );
}

/**
 * A value no declared field plausibly accepts and no transform plausibly produces. Put in
 * a key's place, it makes the schema show whether it was reading that key: a typed field
 * rejects it, an open one carries it into the output, and only a key nothing looks at
 * leaves the result untouched.
 */
const PROBE = Object.freeze({ "weft:unknown-input-probe": true });

/**
 * Structural equality over validated output, deliberately CONSERVATIVE: anything it
 * cannot compare with confidence reads as different, and different means "the key
 * mattered". Both errors are possible here and they are not symmetric — missing a typo
 * costs a run that reviewed the wrong branch and said nothing; a false match costs a
 * refusal to run a workflow whose flag was always valid. Only the first is recoverable
 * by the person typing.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  // PLAIN objects only. A Date, a Map, a class instance — their identity lives in state
  // this walk cannot reach, and two of them are never assumed equal.
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Input schemas are written in TypeScript, so `baseRef` is offered as `--base-ref`. */

function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}
