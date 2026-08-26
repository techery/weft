import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { CompiledUiAsset, CompiledUiCatalog, UiViewMode } from "@techery/weft-sdk";
import { build, type Loader, type Message, type Plugin } from "esbuild";
import ts from "typescript";
import { type GateDiagnostic, GateError } from "./rules.ts";

const UI_IMPORT = /\.ui\.[jt]sx$/;
const UI_FACTORIES = new Map<string, UiViewMode>([
  ["defineUiView", "input"],
  ["defineResultView", "display"],
]);
const MAX_UI_VIEWS = 32;
const MAX_UI_BUNDLE_BYTES = 1_000_000;
const COMPILER_REQUIRE = createRequire(import.meta.url);

export interface DiscoveredUiEntry {
  file: string;
  assetKey: string;
  id: string;
  revision: string;
  mode: UiViewMode;
}

export interface UiDiscovery {
  plugin: Plugin;
  entries: Map<string, DiscoveredUiEntry>;
}

/** Intercept `.ui.tsx` before it reaches the deterministic Node source gate. */
export function discoverUiViews(root: string): UiDiscovery {
  const entries = new Map<string, DiscoveredUiEntry>();
  const ids = new Map<string, string>();
  const plugin: Plugin = {
    name: "weft-ui-token",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: UI_IMPORT }, async (args) => {
        if (!args.path.startsWith(".") && !path.isAbsolute(args.path)) {
          return { errors: [{ text: `UI view imports must be relative, got ${JSON.stringify(args.path)}` }] };
        }
        const requested = path.resolve(args.resolveDir || root, args.path);
        const file = await realpath(requested).catch(() => requested);
        if (!inside(root, file)) {
          return { errors: [{ text: `UI view escapes the workflow root: ${displayPath(root, file)}` }] };
        }
        let entry = entries.get(file);
        if (!entry) {
          if (entries.size >= MAX_UI_VIEWS) {
            return { errors: [{ text: `workflow imports more than ${MAX_UI_VIEWS} UI views` }] };
          }
          const source = await readFile(file, "utf8");
          const meta = readStaticMetadata(source, displayPath(root, file));
          const prior = ids.get(meta.id);
          if (prior && prior !== file) {
            return {
              errors: [
                {
                  text: `duplicate UI view id ${JSON.stringify(meta.id)} in ${displayPath(root, prior)} and ${displayPath(root, file)}`,
                },
              ],
            };
          }
          ids.set(meta.id, file);
          entry = {
            file,
            id: meta.id,
            revision: meta.revision,
            mode: meta.mode,
            assetKey: createHash("sha256").update(displayPath(root, file)).digest("hex"),
          };
          entries.set(file, entry);
        }
        return { path: entry.assetKey, namespace: "weft-ui-token" };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: "weft-ui-token" }, (args) => ({
        loader: "js",
        contents: `export default Object.freeze({ kind: "weft.ui-view", assetKey: ${JSON.stringify(args.path)} });`,
      }));
    },
  };
  return { plugin, entries };
}

export async function compileUiCatalog(
  root: string,
  entries: Iterable<DiscoveredUiEntry>,
): Promise<{ catalog: CompiledUiCatalog; warnings: Message[] }> {
  const assets: CompiledUiAsset[] = [];
  const warnings: Message[] = [];
  for (const entry of [...entries].sort((a, b) => a.assetKey.localeCompare(b.assetKey))) {
    const result = await build({
      stdin: {
        contents: browserBootstrap(entry),
        resolveDir: root,
        sourcefile: `weft-ui:${displayPath(root, entry.file)}`,
        loader: "ts",
      },
      absWorkingDir: root,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      write: false,
      sourcemap: false,
      legalComments: "none",
      minify: true,
      logLevel: "silent",
      plugins: [browserImportPolicy(root)],
    });
    warnings.push(...result.warnings);
    const code = result.outputFiles[0]?.text ?? "";
    const size = Buffer.byteLength(code);
    if (size > MAX_UI_BUNDLE_BYTES) {
      throw new GateError(
        `UI view ${JSON.stringify(entry.id)} is ${size} bytes; limit is ${MAX_UI_BUNDLE_BYTES}`,
      );
    }
    assets.push({
      assetKey: entry.assetKey,
      id: entry.id,
      revision: entry.revision,
      mode: entry.mode,
      protocol: 1,
      code,
      hash: createHash("sha256").update(code).digest("hex"),
    });
  }
  const buildHash = createHash("sha256")
    .update(
      JSON.stringify(
        assets.map(({ assetKey, id, revision, mode, protocol, hash }) => ({
          assetKey,
          id,
          revision,
          mode,
          protocol,
          hash,
        })),
      ),
    )
    .digest("hex");
  return { catalog: { buildHash, assets }, warnings };
}

function readStaticMetadata(
  source: string,
  file: string,
): { id: string; revision: string; mode: UiViewMode } {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const assignment = parsed.statements.find(ts.isExportAssignment);
  const expression = assignment?.expression;
  if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
    throw metadataError(file, "default export must call defineUiView({...}) or defineResultView({...})");
  }
  const mode = UI_FACTORIES.get(expression.expression.text);
  if (!mode) throw metadataError(file, "default export must call defineUiView or defineResultView");
  const object = expression.arguments[0];
  if (!object || !ts.isObjectLiteralExpression(object)) {
    throw metadataError(file, "UI view definition must be an object literal");
  }
  const literal = (name: string): string => {
    const property = object.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
          (ts.isStringLiteral(candidate.name) && candidate.name.text === name)),
    );
    if (!property || !ts.isStringLiteral(property.initializer) || property.initializer.text.trim() === "") {
      throw metadataError(file, `${name} must be a non-empty string literal`);
    }
    return property.initializer.text;
  };
  return { id: literal("id"), revision: literal("revision"), mode };
}

function metadataError(file: string, message: string): GateError {
  const diagnostic: GateDiagnostic = { rule: "ui-metadata", message, file, line: 0, column: 0 };
  return GateError.fromDiagnostics([diagnostic], `invalid UI view ${file}`);
}

function browserImportPolicy(root: string): Plugin {
  const allowedBare = new Set([
    "react",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "react-dom",
    "react-dom/client",
    "scheduler",
    "@techery/weft-sdk/ui",
  ]);
  const supported = /\.[cm]?[jt]sx?$/;
  const compilerFiles = new Set<string>();
  return {
    name: "weft-ui-browser-policy",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "dynamic-import") {
          return { errors: [{ text: `dynamic imports are not supported in workflow UI (${args.path})` }] };
        }
        return null;
      });
      pluginBuild.onResolve({ filter: /^(?:\.{1,2}(?:\/|$)|\/)/ }, async (args) => {
        if (compilerFiles.has(args.importer)) {
          try {
            const resolved = createRequire(args.importer).resolve(args.path);
            compilerFiles.add(resolved);
            return { path: resolved };
          } catch (err) {
            return {
              errors: [{ text: `cannot resolve compiler-owned ${args.path}: ${(err as Error).message}` }],
            };
          }
        }
        const requested = path.resolve(args.resolveDir || root, args.path);
        const file = await realpath(requested).catch(() => requested);
        if (!inside(root, file)) {
          return { errors: [{ text: `browser import escapes the workflow root: ${args.path}` }] };
        }
        return null;
      });
      pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
        if (!allowedBare.has(args.path)) {
          return {
            errors: [{ text: `bare import ${JSON.stringify(args.path)} is not allowed in workflow UI` }],
          };
        }
        try {
          const resolved = COMPILER_REQUIRE.resolve(args.path);
          compilerFiles.add(resolved);
          return { path: resolved };
        } catch (err) {
          return {
            errors: [{ text: `cannot resolve compiler-owned ${args.path}: ${(err as Error).message}` }],
          };
        }
      });
      pluginBuild.onResolve({ filter: /\.(?:css|scss|sass|less)$/ }, (args) => ({
        errors: [{ text: `CSS imports are not supported in workflow UI v1 (${args.path})` }],
      }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        if (compilerFiles.has(args.path)) return null;
        if (!inside(root, await realpath(args.path).catch(() => args.path))) {
          return { errors: [{ text: `browser import escapes the workflow root: ${args.path}` }] };
        }
        if (!supported.test(args.path)) {
          return { errors: [{ text: `unsupported workflow UI asset ${displayPath(root, args.path)}` }] };
        }
        return { contents: await readFile(args.path, "utf8"), loader: loaderFor(args.path) };
      });
    },
  };
}

function browserBootstrap(entry: DiscoveredUiEntry): string {
  return `
import React from "react";
import { createRoot } from "react-dom/client";
import view from ${JSON.stringify(entry.file)};

let initialized = false;
window.addEventListener("message", function initialize(event) {
  if (initialized || event.source !== window.parent) return;
  const data = event.data;
  const port = event.ports && event.ports[0];
  if (!port || !data || data.type !== "weft.ui.init" || data.protocol !== 1) return;
  initialized = true;
  const send = (message) => port.postMessage({ ...message, presentationId: data.presentationId, generation: data.generation });
  const report = (error) => send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  const root = createRoot(document.getElementById("root"), {
    onCaughtError: report,
    onUncaughtError: report,
    onRecoverableError: report,
  });
  const componentProps = view.mode === "input"
    ? { props: data.props, propose: (answer) => send({ type: "candidate", answer }) }
    : { props: data.props };
  try {
    root.render(React.createElement(view.component, componentProps));
    send({ type: "ready" });
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => send({ type: "resize", height: document.documentElement.scrollHeight }));
      observer.observe(document.documentElement);
    } else {
      send({ type: "resize", height: document.documentElement.scrollHeight });
    }
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
  window.removeEventListener("message", initialize);
  port.start();
});
`;
}

function loaderFor(file: string): Loader {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) return "ts";
  if (file.endsWith(".jsx")) return "jsx";
  return "js";
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function displayPath(root: string, file: string): string {
  const relative = path.relative(root, file);
  return inside(root, file) ? relative.split(path.sep).join("/") : file;
}

export function uiMessageToDiagnostic(message: Message, cwd: string): GateDiagnostic {
  const loc = message.location;
  return {
    rule: "ui-bundle-warning",
    message: message.text,
    file: loc?.file ? displayPath(cwd, loc.file) : "<ui>",
    line: loc?.line ?? 0,
    column: (loc?.column ?? 0) + 1,
  };
}
