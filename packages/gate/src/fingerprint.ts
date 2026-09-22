import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";
import ts from "typescript";
import { GateError, isAllowedBare, resolveAllowBare } from "./rules.ts";

export interface FingerprintOptions {
  allowBare?: readonly string[];
}

const MAX_MODULES = 5_000;
const MAX_BYTES = 32 * 1024 * 1024;
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const hostDir = path.dirname(fileURLToPath(import.meta.url));

/** Current executable identity, including the statically resolved host dependency
 * graph. This fingerprints current dependencies; it does not retain their code.
 * Resolution intentionally matches load.ts's host imports rather than workflow cwd.
 */
export async function fingerprintBundle(code: string, options: FingerprintOptions = {}): Promise<string> {
  return (await inspectBundleFingerprint(code, options)).hash;
}

/** Internal loader evidence. Absolute module paths identify shared Node cache entries;
 * they are deliberately excluded from the portable executable hash. */
export async function inspectBundleFingerprint(
  code: string,
  options: FingerprintOptions = {},
): Promise<{ hash: string; modules: ReadonlyMap<string, string> }> {
  const allowBare = resolveAllowBare(options.allowBare ? [...options.allowBare] : undefined);
  const ids = new Set<string>();
  for (const match of code.matchAll(/\brequire\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/g)) {
    const id = match[1] ?? match[2];
    if (id && isAllowedBare(id, allowBare)) ids.add(id);
  }
  const requests = [...ids].sort(compare);
  if (requests.length === 0)
    return {
      hash: digest(JSON.stringify({ format: "weft-executable-v2", code, node: process.versions.node })),
      modules: new Map(),
    };

  try {
    const entries = await Promise.all(
      requests.map(async (id) => {
        const resolved = import.meta.resolve(id);
        if (!resolved.startsWith("file:"))
          throw new Error(`Host import ${id} has no fingerprintable file entry`);
        return { id, file: await realpath(fileURLToPath(resolved)) };
      }),
    );
    const contents = new Map<string, Uint8Array>();
    let bytes = 0;
    const graph = await build({
      entryPoints: Object.fromEntries(entries.map((entry, i) => [`dependency-${i}`, entry.file])),
      absWorkingDir: hostDir,
      outdir: "weft-dependency-fingerprint",
      write: false,
      bundle: true,
      metafile: true,
      platform: "node",
      format: "esm",
      target: "node22",
      // esbuild selects import/require per edge. Enabling import globally makes
      // nested require() edges fingerprint the wrong conditional export.
      conditions: ["node"],
      mainFields: ["main"],
      treeShaking: false,
      logLevel: "silent",
      plugins: [
        {
          name: "bounded-dependency-fingerprint",
          setup(plugin) {
            plugin.onLoad({ filter: /.*/ }, async (args) => {
              if (args.namespace !== "file") return null;
              const file = await realpath(args.path);
              if (!contents.has(file)) {
                const source = await readFile(file);
                bytes += source.byteLength;
                contents.set(file, source);
                if (contents.size > MAX_MODULES || bytes > MAX_BYTES)
                  throw new Error("External dependency fingerprint exceeds its module or byte bound");
                if (/\.[cm]?[jt]sx?$/.test(file)) {
                  const ast = ts.createSourceFile(
                    file,
                    source.toString("utf8"),
                    ts.ScriptTarget.Latest,
                    false,
                    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
                  );
                  const inspect = (node: ts.Node, inFunction = false): void => {
                    if (
                      ts.isCallExpression(node) &&
                      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
                      (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0]))
                    ) {
                      throw new Error("Dependency graph includes an unresolved dynamic module import");
                    }
                    if (
                      ts.isCallExpression(node) &&
                      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                        (inFunction &&
                          ts.isIdentifier(node.expression) &&
                          node.expression.text === "require"))
                    ) {
                      throw new Error(
                        "Dependency graph includes a deferred module import; use static imports or top-level require calls",
                      );
                    }
                    ts.forEachChild(node, (child) => inspect(child, inFunction || ts.isFunctionLike(node)));
                  };
                  inspect(ast);
                }
              }
              return null;
            });
          },
        },
      ],
    });
    if (!graph.metafile) throw new Error("Dependency graph metadata is missing");
    const unsupported = graph.warnings.filter((warning) =>
      ["unsupported-require-call", "unsupported-dynamic-import", "require-resolve-not-external"].includes(
        warning.id,
      ),
    );
    if (unsupported.length)
      throw new Error(
        `Dependency graph includes an unresolved dynamic module: ${unsupported.map((warning) => warning.text).join("; ")}`,
      );

    const packageByDirectory = new Map<
      string,
      Promise<{ root: string; name: string; version: string; manifest: string }>
    >();
    const packageOf = (
      file: string,
    ): Promise<{ root: string; name: string; version: string; manifest: string }> => {
      const dir = path.dirname(file);
      let cached = packageByDirectory.get(dir);
      if (!cached) {
        cached = (async () => {
          let cursor = dir;
          const manifests: Array<{ dir: string; content: string }> = [];
          while (true) {
            try {
              const raw = await readFile(path.join(cursor, "package.json"), "utf8");
              const data = JSON.parse(raw) as { name?: string; version?: string };
              manifests.push({ dir: cursor, content: digest(raw) });
              // Nested package.json files can select CJS/ESM without identifying a package.
              if (data.name)
                return {
                  root: cursor,
                  name: data.name,
                  version: data.version ?? "unversioned",
                  manifest: digest(
                    JSON.stringify(
                      manifests.map((item) => ({
                        directory: path.relative(cursor, item.dir).split(path.sep).join("/"),
                        content: item.content,
                      })),
                    ),
                  ),
                };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            const parent = path.dirname(cursor);
            if (parent === cursor) throw new Error(`No owning package manifest for external module ${file}`);
            cursor = parent;
          }
        })();
        packageByDirectory.set(dir, cached);
      }
      return cached;
    };
    const names = new Map<string, string>();
    const packages = new Map<string, { name: string; version: string; manifest: string }>();
    const inputs = await Promise.all(
      Object.entries(graph.metafile.inputs).map(async ([input, metadata]) => {
        const file = await realpath(path.resolve(hostDir, input));
        const owner = await packageOf(file);
        const identity = `${owner.name}@${owner.version}/${path.relative(owner.root, file).split(path.sep).join("/")}`;
        names.set(input, identity);
        names.set(file, identity);
        packages.set(`${owner.root}:${owner.manifest}`, {
          name: owner.name,
          version: owner.version,
          manifest: owner.manifest,
        });
        const content = contents.get(file) ?? (await readFile(file));
        return {
          input,
          file,
          identity,
          manifest: owner.manifest,
          content: digest(content),
          imports: metadata.imports,
        };
      }),
    );
    const modules = inputs
      .map((input) => ({
        file: input.identity,
        content: input.content,
        imports: input.imports
          .map((dependency) => {
            if (dependency.external && !isBuiltin(dependency.path))
              throw new Error(`Unresolved external module in dependency graph: ${dependency.path}`);
            return { kind: dependency.kind, target: names.get(dependency.path) ?? dependency.path };
          })
          .sort((a, b) => compare(`${a.kind}:${a.target}`, `${b.kind}:${b.target}`)),
      }))
      .sort((a, b) => compare(`${a.file}:${a.content}`, `${b.file}:${b.content}`));
    const dependencyPackages = [...packages.values()].sort((a, b) =>
      compare(`${a.name}:${a.version}:${a.manifest}`, `${b.name}:${b.version}:${b.manifest}`),
    );
    const hash = digest(
      JSON.stringify({
        format: "weft-executable-v2",
        code,
        node: process.versions.node,
        esbuild: esbuildVersion,
        entries: entries.map((entry) => ({ import: entry.id, file: names.get(entry.file) })),
        packages: dependencyPackages,
        modules,
      }),
    );
    return {
      hash,
      modules: new Map(
        inputs.map((input) => [
          input.file,
          digest(
            JSON.stringify({
              content: input.content,
              manifest: input.manifest,
              imports: input.imports
                .map((dependency) => ({
                  kind: dependency.kind,
                  target: dependency.external ? dependency.path : path.resolve(hostDir, dependency.path),
                }))
                .sort((a, b) => compare(`${a.kind}:${a.target}`, `${b.kind}:${b.target}`)),
            }),
          ),
        ]),
      ),
    };
  } catch (error) {
    throw new GateError(
      `Cannot fingerprint workflow host dependencies: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
