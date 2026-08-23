/**
 * The sandboxed loader. The bundle is a CommonJS script, so it runs the way Node runs a
 * module — wrapped in `(function (exports, require, module, …))` — except the globals it
 * closes over come from a `node:vm` context we built: no timers, no `fetch`, no
 * `process.env`, a `Math` whose `.random` throws, a `Date` that refuses to read the clock.
 *
 * This is a determinism fence, not a security boundary: the scripts are our own agents'.
 * A workflow that reaches for a banned global gets the same guidance the AST rules print,
 * one layer down, which is what catches the clever paths static analysis misses
 * (`const D = Date; D.now()`). If untrusted scripts ever enter the picture the seam moves
 * to `node:worker_threads` (a replaced global on a real thread) or an isolate; nothing
 * above this module depends on how the fence is built.
 *
 * Allow-listed bare imports resolve to the HOST's modules, pre-imported before execution
 * because `require` is synchronous. That is what makes a workflow's `z.object({…})` a real
 * host-Zod schema the engine can validate and convert to JSON Schema.
 */
import path from "node:path";
import vm from "node:vm";
import { isWorkflowDefinition, type WorkflowDefinition } from "@weft/sdk";
import { type BundleOptions, bundleWorkflow, INLINE_FILE } from "./bundle.ts";
import { GateError, isAllowedBare, resolveAllowBare } from "./rules.ts";

export interface LoadOptions extends BundleOptions {
  /** Fallback workflow name when the file has no `meta.name` (inline source, mainly). */
  name?: string;
}

export interface LoadedWorkflow {
  def: WorkflowDefinition;
  /** Content hash of the bundle: the version this run pins. */
  hash: string;
  code: string;
  name: string;
}

export interface InstantiateOptions {
  /** Script name for stack traces; also the `__filename` the module sees. */
  filename?: string;
  allowBare?: readonly string[];
}

type ModuleFactory = (
  exports: Record<string, unknown>,
  require: (id: string) => unknown,
  module: { exports: Record<string, unknown> },
  filename: string,
  dirname: string,
) => void;

/** Bundle a workflow and execute it in the sandbox. */
export async function loadWorkflow(opts: LoadOptions): Promise<LoadedWorkflow> {
  const { code, hash } = await bundleWorkflow(opts);
  const entry = opts.entry ? path.resolve(opts.cwd ?? process.cwd(), opts.entry) : undefined;
  const def = await instantiateBundle(code, {
    filename: entry ?? INLINE_FILE,
    ...(opts.allowBare ? { allowBare: opts.allowBare } : {}),
  });
  const fromFile = entry ? path.basename(entry, path.extname(entry)) : undefined;
  return { def, hash, code, name: def.meta.name ?? opts.name ?? fromFile ?? "inline" };
}

/**
 * Execute an already-bundled workflow script and return its definition. Hosts that stored
 * a run's `script.ts` can re-instantiate from it without re-bundling.
 */
export async function instantiateBundle(
  code: string,
  opts: InstantiateOptions = {},
): Promise<WorkflowDefinition> {
  const filename = opts.filename ?? INLINE_FILE;
  const allowBare = resolveAllowBare(opts.allowBare);
  const requireShim = await createRequireShim(code, allowBare);
  const context = createSandbox();

  // The wrapper opens on the same line as the bundle so line numbers (and the inline
  // source map esbuild emitted) still line up with the .ts the author wrote.
  const wrapper = `(function (exports, require, module, __filename, __dirname) {${code}\n})`;
  const factory = new vm.Script(wrapper, { filename }).runInContext(context) as ModuleFactory;
  const mod = { exports: {} as Record<string, unknown> };

  const where = displayName(filename);
  try {
    factory(mod.exports, requireShim, mod, filename, path.dirname(filename));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GateError(message, [{ rule: "sandbox", message, file: where, line: 0, column: 0 }], {
      cause: err,
    });
  }

  // `isWorkflowDefinition` vouches for kind + run; meta is checked here because the engine
  // reads it immediately (and a hand-rolled object would otherwise fail much later).
  const def = mod.exports.default ?? mod.exports;
  if (!isWorkflowDefinition(def) || typeof def.meta?.description !== "string") {
    const message =
      `no workflow definition exported from ${where}` + ' - use "export default defineWorkflow({ … }, run)"';
    throw new GateError(message, [{ rule: "no-workflow-export", message, file: where, line: 0, column: 0 }]);
  }
  return def;
}

/**
 * The globals a workflow gets. Everything determinism-relevant is either replaced by a
 * throwing stand-in that names its `ctx` equivalent, or absent from the context entirely
 * (Node's timers and `process` are not ECMAScript intrinsics, so a fresh vm context has
 * none of them to begin with).
 */
function createSandbox(): vm.Context {
  const sandbox: Record<string, unknown> = {
    console,
    JSON,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
    Promise,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    EvalError,
    URIError,
    AggregateError,
    Math: sandboxMath(),
    Date: sandboxDate(),
    fetch: banned("fetch() is unavailable in workflow code - use ctx.fetch(url, { schema })"),
    setTimeout: banned('setTimeout() is unavailable in workflow code - use ctx.sleep("10m")'),
    setInterval: banned("setInterval() is unavailable in workflow code - use ctx.sleep() in a loop"),
    setImmediate: banned("setImmediate() is unavailable in workflow code - use ctx.sleep()"),
    process: { env: sandboxProcessEnv() },
  };
  return vm.createContext(sandbox, { name: "weft:workflow" });
}

function sandboxMath(): typeof Math {
  return new Proxy(Math, {
    get(target, prop, receiver) {
      if (prop === "random")
        throw new Error("Math.random() is unavailable in workflow code - use ctx.random()");
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** `new Date(value)` is a pure conversion and stays; anything that reads the clock does not. */
function sandboxDate(): DateConstructor {
  return new Proxy(Date, {
    construct(target, args, newTarget) {
      if (args.length === 0) throw new Error("new Date() is unavailable in workflow code - use ctx.now()");
      return Reflect.construct(target, args, newTarget);
    },
    // Plain Date() (no `new`) also reads the wall clock — same guidance.
    apply() {
      throw new Error("Date() is unavailable in workflow code - use ctx.now()");
    },
    get(target, prop, receiver) {
      if (prop === "now") throw new Error("Date.now() is unavailable in workflow code - use ctx.now()");
      return Reflect.get(target, prop, receiver);
    },
  });
}

function sandboxProcessEnv(): Record<string, string> {
  const message = "process.env is unavailable - use ctx.env.get() / ctx.secret()";
  return new Proxy({} as Record<string, string>, {
    get() {
      throw new Error(message);
    },
    has() {
      throw new Error(message);
    },
    set() {
      throw new Error(message);
    },
  });
}

function banned(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

/**
 * `require` is synchronous, so every module the bundle can legally ask for is imported
 * first: the allow-list itself plus any allow-listed subpath the emitted code mentions.
 * Everything else throws — including an indirect `require` the AST rules cannot see.
 */
async function createHostModules(
  code: string,
  allowBare: readonly string[],
): Promise<Map<string, HostModule>> {
  const wanted = new Set(allowBare);
  for (const id of requestedModuleIds(code)) {
    if (isAllowedBare(id, allowBare)) wanted.add(id);
  }
  const entries = await Promise.all(
    [...wanted].map(async (id): Promise<[string, HostModule]> => {
      try {
        return [id, { namespace: (await import(id)) as Record<string, unknown> }];
      } catch (err) {
        return [id, { error: err }];
      }
    }),
  );
  return new Map(entries);
}

interface HostModule {
  namespace?: Record<string, unknown>;
  error?: unknown;
}

async function createRequireShim(
  code: string,
  allowBare: readonly string[],
): Promise<(id: string) => unknown> {
  const modules = await createHostModules(code, allowBare);
  return (id: string): unknown => {
    const hit = modules.get(id);
    // esbuild's CJS output reads named exports straight off the required value, so the
    // module namespace object is exactly the right shape to hand back.
    if (hit?.namespace) return hit.namespace;
    if (hit?.error) {
      const detail = hit.error instanceof Error ? hit.error.message : String(hit.error);
      throw new Error(`import "${id}" is allow-listed but could not be resolved on the host: ${detail}`);
    }
    throw new Error(`import "${id}" is not allowed in workflow code`);
  };
}

/** Literal `require("…")` ids in the emitted bundle. */
function requestedModuleIds(code: string): string[] {
  const ids: string[] = [];
  const pattern = /\brequire\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/g;
  for (const match of code.matchAll(pattern)) {
    const id = match[1] ?? match[2];
    if (id) ids.push(id);
  }
  return ids;
}

function displayName(filename: string): string {
  return path.isAbsolute(filename) ? path.basename(filename) : filename;
}
