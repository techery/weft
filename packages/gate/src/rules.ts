/**
 * The AST rules. Workflow code must be deterministic and side-effect free on its own:
 * every clock read, random draw, timer, network call, and environment read goes through
 * `ctx`, so the engine can journal it and serve it back on replay. These rules reject the
 * raw APIs at parse time — before a single line runs — and hand back a fix-it that names
 * the `ctx` replacement.
 *
 * Parsing uses the TypeScript compiler API (no second parser dependency, no type-check in
 * the hot path — `weft check` runs `tsc` separately for that). Occurrences are flagged
 * uniformly: there is no scope analysis, so a local named `fetch` is still a finding. That
 * is deliberate — the rule set is a hygiene fence, and the false-positive cure (rename it)
 * is cheaper than the miss.
 */
import { isBuiltin } from "node:module";
import ts from "typescript";

/** One rule violation, positioned for an editor: 1-based line and column. */
export interface GateDiagnostic {
  rule: string;
  message: string;
  file: string;
  line: number;
  column: number;
  fixIt?: string;
}

/** Bare imports every workflow may use: the authoring surface and its schema library. */
export const DEFAULT_ALLOW_BARE: readonly string[] = ["@techery/weft-sdk", "zod"];

/** `@techery/weft-sdk` is the authoring surface; a custom allow-list extends it, never removes it. */
const REQUIRED_ALLOW_BARE: readonly string[] = ["@techery/weft-sdk"];

const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"]);

/**
 * Reachable only through the garbage collector, whose timing v8 does not promise. A
 * workflow whose result depends on when a reference was collected replays differently on
 * the same journal.
 */
const GC_GLOBALS = new Set(["WeakRef", "FinalizationRegistry"]);

/**
 * Locale- and timezone-sensitive formatting and collation. These read ambient ICU data
 * and the host timezone, so the same workflow produces different prompts — and a
 * different `localeCompare` sort order — on a differently configured machine.
 */
const LOCALE_METHODS = new Set([
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "localeCompare",
]);

/** Every rule and the fix-it it hands back — the whole banned list, in one place. */
const FIX_ITS = {
  "no-date-now": "Date.now() is unavailable - use ctx.now()",
  "no-argless-date": "new Date() is unavailable - use ctx.now(); new Date(value) is fine",
  "no-math-random": "Math.random() is unavailable - use ctx.random() or ctx.uuid()",
  "no-timers": 'timers are unavailable - use ctx.sleep("10m") for durable waits',
  "no-global-fetch": "fetch() is unavailable - use ctx.fetch(url, { schema })",
  "no-process-env": "process.env is unavailable - use ctx.env.get() / ctx.secret()",
  "no-require": "require() is unavailable - use a relative import; helpers belong in ./lib",
  "no-gc-globals":
    "WeakRef/FinalizationRegistry are unavailable - GC timing is not deterministic, so a replay would diverge",
  "no-locale":
    "locale-sensitive formatting is unavailable - it reads ambient ICU data and the host timezone; format explicitly (toFixed, toISOString, a plain comparator)",
  "no-intl": "Intl is unavailable - it reads ambient locale and timezone; format explicitly",
  "no-bare-import":
    "bare imports are not allowed in workflow code - relative imports are bundled; put helpers in ./lib",
} as const satisfies Record<string, string>;

/** The rule ids {@link checkSource} can report. */
export type GateRule = keyof typeof FIX_ITS;

/**
 * Everything the gate refuses: rule violations, a bundle that would not build, a sandbox
 * that stopped the module, a file that exports no workflow. `diagnostics` is empty only
 * for plain usage errors.
 */
export class GateError extends Error {
  readonly diagnostics: GateDiagnostic[];

  constructor(message: string, diagnostics: GateDiagnostic[] = [], opts: { cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GateError";
    this.diagnostics = diagnostics;
  }

  /** Build the error a failed gate throws: a headline plus one indented line per finding. */
  static fromDiagnostics(diagnostics: GateDiagnostic[], headline = "workflow gate"): GateError {
    const count = `${diagnostics.length} violation${diagnostics.length === 1 ? "" : "s"}`;
    return new GateError(`${headline}: ${count}\n${formatDiagnostics(diagnostics)}`, diagnostics);
  }
}

/** Render diagnostics the way `weft check` prints them. */
export function formatDiagnostics(diagnostics: readonly GateDiagnostic[]): string {
  return diagnostics
    .map((d) => {
      const head = `  ${d.file}:${d.line}:${d.column}  ${d.rule}  ${d.message}`;
      return d.fixIt ? `${head}\n    fix: ${d.fixIt}` : head;
    })
    .join("\n");
}

/** Normalize an allow-list: caller entries plus the always-allowed `@techery/weft-sdk`. */
export function resolveAllowBare(allowBare?: readonly string[]): string[] {
  const list = allowBare ?? DEFAULT_ALLOW_BARE;
  return [...new Set([...REQUIRED_ALLOW_BARE, ...list])];
}

/**
 * Run the rules over one source file. Returns `[]` when the file is clean.
 * `allowBare` defaults to {@link DEFAULT_ALLOW_BARE}; a package matches by exact name or
 * by subpath (`zod` allows `zod/v4`).
 */
export function checkSource(
  source: string,
  fileName = "<workflow>",
  allowBare?: readonly string[],
): GateDiagnostic[] {
  const allowed = resolveAllowBare(allowBare);
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2023, true, scriptKindFor(fileName));
  const out: GateDiagnostic[] = [];

  const report = (node: ts.Node, rule: GateRule, message: string): void => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const at = { file: fileName, line: pos.line + 1, column: pos.character + 1 };
    out.push({ rule, message, ...at, fixIt: FIX_ITS[rule] });
  };

  const checkSpecifier = (node: ts.Node, spec: string): void => {
    if (isRelativeOrAbsolute(spec) || isAllowedBare(spec, allowed)) return;
    const what = isBuiltin(spec) ? `node builtin "${spec}"` : `bare import "${spec}"`;
    report(node, "no-bare-import", `${what} is not allowed in workflow code`);
  };

  const visit = (node: ts.Node): void => {
    const member = staticMemberAccess(node);
    if (member?.object === "Date" && member.property === "now") {
      report(node, "no-date-now", "Date.now() is not allowed in workflow code");
    } else if (member?.object === "Math" && member.property === "random") {
      report(node, "no-math-random", "Math.random() is not allowed in workflow code");
    } else if (member?.object === "process" && member.property === "env") {
      report(node, "no-process-env", "process.env is not allowed in workflow code");
    } else if (member?.object === "Intl") {
      report(node, "no-intl", `Intl.${member.property} is not allowed in workflow code`);
    }

    // Property name only, like every other rule here: no scope analysis, so a method of
    // your own called `localeCompare` is still a finding. Renaming it is the cheap cure.
    if (
      (ts.isPropertyAccessExpression(node) && LOCALE_METHODS.has(node.name.text)) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        LOCALE_METHODS.has(node.argumentExpression.text))
    ) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : (node.argumentExpression as ts.StringLiteralLike).text;
      report(node, "no-locale", `${name}() is not allowed in workflow code`);
    }

    if (ts.isIdentifier(node) && GC_GLOBALS.has(node.text) && !isDeclarationName(node)) {
      report(node, "no-gc-globals", `${node.text} is not allowed in workflow code`);
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
      if (!node.arguments || node.arguments.length === 0) {
        report(node, "no-argless-date", "argless new Date() is not allowed in workflow code");
      }
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) checkSpecifier(node, arg.text);
        else report(node, "no-bare-import", "dynamic import() needs a literal relative specifier");
      } else if (ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        if (TIMERS.has(callee)) {
          report(node, "no-timers", `${callee}() is not allowed in workflow code`);
        } else if (callee === "fetch") {
          report(node, "no-global-fetch", "global fetch() is not allowed in workflow code");
        } else if (callee === "require") {
          report(node, "no-require", "require() is not allowed in workflow code");
        }
      }
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) checkSpecifier(node, node.moduleSpecifier.text);
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      if (!node.isTypeOnly) checkSpecifier(node, node.moduleSpecifier.text);
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = node.moduleReference.expression;
      if (ts.isStringLiteralLike(spec)) checkSpecifier(node, spec.text);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return out;
}

/** `a.b` and `a["b"]` alike, so `process["env"]` is not a way around the rules. */
function staticMemberAccess(node: ts.Node): { object: string; property: string } | undefined {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return { object: node.expression.text, property: node.name.text };
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return { object: node.expression.text, property: node.argumentExpression.text };
  }
  return undefined;
}

/**
 * True when the identifier IS the name being declared (`const WeakRef = …`, a property
 * key, a parameter). Flagging those would report the declaration rather than a use, and a
 * workflow is free to name its own things whatever it likes.
 */
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isImportSpecifier(parent)) &&
    parent.name === node
  );
}

/** Relative imports are bundled and hashed with the script; absolute paths likewise. */
function isRelativeOrAbsolute(spec: string): boolean {
  return (
    spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === ".." || spec.startsWith("/")
  );
}

/** Exact package match or a subpath of one (`zod` allows `zod/v4`). */
export function isAllowedBare(spec: string, allowed: readonly string[]): boolean {
  return allowed.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
