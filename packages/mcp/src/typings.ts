/**
 * `weft_types` hands a session the authoring surface it needs to write a workflow inline.
 * The text is read off the *installed* @weft/sdk rather than baked in here, so the two can
 * never drift: what the session reads is what the gate will compile.
 *
 * @weft/mcp does not depend on @weft/sdk directly — @weft/host and @weft/core do — so the
 * resolution hops through them before giving up.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The authoring surface, in the order a reader wants it: ctx, then defineWorkflow, then schemas. */
const FILES = ["types.ts", "define.ts", "schema.ts"] as const;

/** Packages that do depend on @weft/sdk, used as resolution hops. */
const VIA = ["@weft/host", "@weft/core"] as const;

let cached: Promise<string> | undefined;

/** The concatenated SDK source, read once per process. */
export function sdkTypings(): Promise<string> {
  cached ??= readTypings();
  return cached;
}

async function readTypings(): Promise<string> {
  const dir = sdkSourceDir();
  const parts = await Promise.all(
    FILES.map(async (file) => {
      const text = await readFile(join(dir, file), "utf8");
      return `// ---------- @weft/sdk/${file} ----------\n\n${text}`;
    }),
  );
  return parts.join("\n");
}

function sdkSourceDir(): string {
  const entry = resolveSdkEntry();
  const candidates = [dirname(entry), join(dirname(entry), "..", "src")];
  for (const dir of candidates) {
    if (existsSync(join(dir, FILES[0]))) return dir;
  }
  throw new Error(`@weft/sdk resolved to ${entry}, but its TypeScript sources are not beside it`);
}

function resolveSdkEntry(): string {
  const here = createRequire(import.meta.url);
  try {
    return here.resolve("@weft/sdk");
  } catch {
    // Not a direct dependency: reach it through one that is.
  }
  for (const id of VIA) {
    try {
      return createRequire(here.resolve(id)).resolve("@weft/sdk");
    } catch {
      // try the next hop
    }
  }
  throw new Error(`cannot resolve @weft/sdk from ${import.meta.url} (tried directly and via ${VIA.join(", ")})`);
}
