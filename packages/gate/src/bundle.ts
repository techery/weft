/**
 * Bundling. A workflow is one entry file plus its relative imports (`./schemas`, `./lib`),
 * which esbuild inlines into a single CommonJS script; allow-listed bare imports stay
 * external and are handed the host's real modules at load time, so a workflow's `z.object`
 * is the same Zod the engine validates with.
 *
 * The gate runs inside the build: an `onLoad` hook reads every module esbuild pulls in and
 * checks it, so a `Date.now()` hiding in `./schemas.ts` fails the build just like one in the
 * entry. The returned `hash` is the SHA-256 of the emitted code — that is the content hash a
 * run is versioned by, and it covers every bundled module.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CompiledUiCatalog } from "@techery/weft-sdk";
import { type BuildFailure, build, type Loader, type Message, type Plugin } from "esbuild";
import { checkSource, type GateDiagnostic, GateError, resolveAllowBare } from "./rules.ts";
import { compileUiCatalog, discoverUiViews, uiMessageToDiagnostic } from "./ui-bundle.ts";

export interface BundleOptions {
  /** Path to the workflow file; relative paths resolve against `cwd`. */
  entry?: string;
  /** Inline TypeScript source (MCP/CLI hand the engine a string); relative imports resolve against `cwd`. */
  source?: string;
  /** Resolution root. Defaults to the entry's directory, or `process.cwd()` for inline source. */
  cwd?: string;
  /** Replaces {@link DEFAULT_ALLOW_BARE}; `@techery/weft-sdk` stays allowed regardless. */
  allowBare?: string[];
}

export interface BundleResult {
  code: string;
  /** SHA-256 hex of `code` — the workflow's content version. */
  hash: string;
  /** Hash of browser assets and metadata; intentionally independent from the Node definition hash. */
  buildHash: string;
  /** Browser programs discovered through `.ui.tsx` imports. */
  uiCatalog: CompiledUiCatalog;
  /** Non-fatal notes (esbuild warnings). Rule violations throw, so they never appear here. */
  diagnostics: GateDiagnostic[];
}

/** The name inline source is reported under, in diagnostics and in the source map. */
export const INLINE_FILE = "<inline>";

const LOADABLE = /\.[cm]?[jt]sx?$/;

/** Bundle a workflow, gating the entry and every relative module it pulls in. */
export async function bundleWorkflow(opts: BundleOptions): Promise<BundleResult> {
  if (!opts.entry && opts.source === undefined) {
    throw new GateError("bundleWorkflow: pass either an entry path or inline source");
  }

  const requestedBase = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const requestedEntry = opts.entry ? path.resolve(requestedBase, opts.entry) : undefined;
  // macOS commonly exposes /var as a symlink to /private/var. esbuild canonicalizes
  // module paths, so canonicalize our comparison root as well or diagnostics under a
  // perfectly ordinary temp directory appear as machine-specific absolute paths.
  const entry = requestedEntry ? await realpath(requestedEntry).catch(() => requestedEntry) : undefined;
  const requestedCwd = opts.cwd ? requestedBase : entry ? path.dirname(entry) : requestedBase;
  const cwd = await realpath(requestedCwd).catch(() => requestedCwd);
  const allowBare = resolveAllowBare(opts.allowBare);
  const ui = discoverUiViews(cwd);

  const violations: GateDiagnostic[] = [];
  const gatePlugin: Plugin = {
    name: "weft-gate",
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: LOADABLE }, async (args) => {
        if (args.namespace !== "file") return null;
        const contents = await readFile(args.path, "utf8");
        violations.push(...checkSource(contents, displayPath(cwd, args.path), allowBare));
        return { contents, loader: loaderFor(args.path) };
      });
    },
  };

  // Inline source never reaches onLoad (esbuild feeds stdin straight to the parser).
  if (entry === undefined && opts.source !== undefined) {
    violations.push(...checkSource(opts.source, INLINE_FILE, allowBare));
  }

  let warnings: Message[] = [];
  let code: string;
  try {
    const result = await build({
      ...(entry
        ? { entryPoints: [entry] }
        : {
            stdin: {
              contents: opts.source ?? "",
              resolveDir: cwd,
              sourcefile: INLINE_FILE,
              loader: "ts" as Loader,
            },
          }),
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node22",
      write: false,
      sourcemap: "inline",
      external: [...allowBare],
      absWorkingDir: cwd,
      logLevel: "silent",
      legalComments: "none",
      plugins: [ui.plugin, gatePlugin],
    });
    warnings = result.warnings;
    code = result.outputFiles[0]?.text ?? "";
  } catch (err) {
    // A rule violation usually explains the build failure (an unresolvable banned import),
    // so report the gate first and fall back to esbuild's own message.
    if (violations.length > 0) throw GateError.fromDiagnostics(sortDiagnostics(violations));
    throw esbuildFailure(err, cwd);
  }

  if (violations.length > 0) throw GateError.fromDiagnostics(sortDiagnostics(violations));

  const compiledUi = await compileUiCatalog(cwd, ui.entries.values()).catch((err: unknown) => {
    if (err instanceof GateError) throw err;
    throw esbuildFailure(err, cwd);
  });
  return {
    code,
    hash: createHash("sha256").update(code).digest("hex"),
    buildHash: compiledUi.catalog.buildHash,
    uiCatalog: compiledUi.catalog,
    diagnostics: [
      ...warnings.map((w) => messageToDiagnostic(w, "esbuild-warning", cwd)),
      ...compiledUi.warnings.map((w) => uiMessageToDiagnostic(w, cwd)),
    ],
  };
}

function esbuildFailure(err: unknown, cwd: string): Error {
  const errors = (err as BuildFailure | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return err instanceof Error ? err : new GateError(String(err));
  }
  const diagnostics = errors.map((e) => messageToDiagnostic(e, "bundle-failed", cwd));
  return GateError.fromDiagnostics(diagnostics, "workflow bundle failed");
}

function messageToDiagnostic(message: Message, rule: string, cwd: string): GateDiagnostic {
  const loc = message.location;
  return {
    rule,
    message: message.text,
    file: loc ? displayPath(cwd, loc.file) : INLINE_FILE,
    line: loc?.line ?? 0,
    column: (loc?.column ?? 0) + 1,
  };
}

function sortDiagnostics(diagnostics: GateDiagnostic[]): GateDiagnostic[] {
  return [...diagnostics].sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule),
  );
}

/** Paths are reported relative to the workflow root, so diagnostics are machine-independent. */
function displayPath(cwd: string, file: string): string {
  if (!path.isAbsolute(file)) return file;
  const rel = path.relative(cwd, file);
  return rel === "" || rel.startsWith("..") ? file : rel.split(path.sep).join("/");
}

function loaderFor(file: string): Loader {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (/\.[cm]?js$/.test(file)) return "js";
  return "ts";
}
