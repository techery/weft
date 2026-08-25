/**
 * The built workflow manager, served from disk.
 *
 * `apps/ui` builds into `<this package>/web`, which sits one level above both `src/` and
 * `dist/` — so the same relative lookup finds it whether the daemon is running off source
 * in this repo or off a published tarball. Nothing is compiled or fetched at request time:
 * `index.html` is read once at startup, hashed assets are read on first request and kept.
 *
 * When that directory is absent — a fresh checkout that has not run `pnpm build` — this
 * module reports nothing and {@link createApp} serves its own built-in page instead. The
 * daemon is still a working UI with nothing installed; the manager is the richer surface
 * on top.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Where `apps/ui` builds to, resolved the same way from `src/` and from `dist/`. */
export const BUNDLED_WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

export interface WebAsset {
  /** An exact, unpooled buffer — what a Response body wants. */
  body: ArrayBuffer;
  contentType: string;
  /** True for content-hashed files, which may be cached forever. */
  immutable: boolean;
}

export interface WebBundle {
  /** Absolute path the bundle was opened from. */
  root: string;
  /** `index.html`, read at open time — the document every client-side route serves. */
  index: string;
  /** One file by request path, or `undefined` when it is not a file in the bundle. */
  read(pathname: string): Promise<WebAsset | undefined>;
}

const CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * Open the bundle at `root`, or return `undefined` when there is nothing built there.
 * A directory without an `index.html` is not a bundle: there would be no document to
 * serve the manager's own routes from.
 */
export function openWebBundle(root: string): WebBundle | undefined {
  const base = resolve(root);
  const indexPath = resolve(base, "index.html");
  if (!existsSync(indexPath)) return undefined;

  let index: string;
  try {
    index = readFileSync(indexPath, "utf8");
  } catch {
    return undefined;
  }

  // The bundle's contents are fixed for the life of the process and its filenames are
  // content-hashed, so a read is worth keeping.
  const cache = new Map<string, WebAsset>();
  return {
    root: base,
    index,
    read: (pathname) => readAsset(base, cache, pathname),
  };
}

async function readAsset(
  base: string,
  cache: Map<string, WebAsset>,
  pathname: string,
): Promise<WebAsset | undefined> {
  const relative = requestPathToRelative(pathname);
  if (relative === undefined) return undefined;

  const cached = cache.get(relative);
  if (cached) return cached;

  const full = resolve(base, relative);
  // `..` that climbs out, and anything a decode turned into an absolute path, ends here.
  if (full !== base && !full.startsWith(base + sep)) return undefined;

  let bytes: Buffer;
  try {
    const info = await stat(full);
    if (!info.isFile()) return undefined;
    bytes = await readFile(full);
  } catch {
    return undefined;
  }

  const asset: WebAsset = {
    // Copied into an exact ArrayBuffer: a Buffer can be a view into a shared pool, and
    // handing that to a Response would expose whatever else the pool is holding.
    body: new Uint8Array(bytes).buffer,
    contentType: contentTypeOf(relative),
    immutable: relative.startsWith("assets/"),
  };
  cache.set(relative, asset);
  return asset;
}

/**
 * A request path as a path relative to the bundle root, or `undefined` when it cannot be
 * one. Leading slashes are dropped before any `resolve()` sees them — `resolve(base, "/etc/passwd")`
 * would otherwise ignore `base` entirely — and a backslash is refused outright because it
 * is a separator on Windows and a literal filename character elsewhere.
 */
function requestPathToRelative(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const trimmed = decoded.replace(/^\/+/, "");
  if (trimmed === "" || trimmed.endsWith("/")) return undefined;
  return trimmed;
}

function contentTypeOf(relative: string): string {
  const dot = relative.lastIndexOf(".");
  const ext = dot === -1 ? "" : relative.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
