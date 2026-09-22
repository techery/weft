/** Retained workflow provenance is deliberately separate from edit-tolerant path refs. */
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fingerprintBundle, instantiateBundle } from "@techery/weft-gate";
import { type CompiledUiCatalog, StepError } from "@techery/weft-sdk";
import * as z from "zod";
import { mergedAllowBare, type PersistedDef, type Weft } from "./weft.ts";

export interface RetainedWorkflow {
  name: string;
  code: string;
  hash: string;
  uiCatalog?: CompiledUiCatalog;
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const retainedManifest = z
  .object({
    format: z.literal(1),
    name: z.string().min(1),
    bundleRef: hash,
    executableHash: hash,
    uiCatalog: z
      .object({
        buildHash: z.string().min(1),
        assets: z.array(
          z
            .object({
              assetKey: z.string(),
              id: z.string(),
              revision: z.string(),
              mode: z.enum(["input", "display"]),
              protocol: z.literal(1),
              hash,
              blobRef: hash,
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Retain the exact bundle/name/UI graph BEFORE engine.start. Repeated identical writes
 * are idempotent; a run's original provenance cannot be replaced. Bare dependencies are
 * fingerprinted, not copied: retained resume refuses changes in their current graph.
 */
export async function persistRetainedWorkflow(
  weft: Weft,
  runId: string,
  workflow: RetainedWorkflow,
): Promise<void> {
  const file = manifestPath(weft, runId);
  const allowBare = mergedAllowBare(weft.config);
  const currentHash = await fingerprintBundle(workflow.code, { ...(allowBare ? { allowBare } : {}) });
  if (currentHash !== workflow.hash) {
    throw new StepError(
      "recovery_required",
      `run ${runId}: workflow dependencies changed before provenance could be retained; load the workflow again`,
    );
  }
  const bundle = await weft.engine.blobs.put(workflow.code, {
    kind: "workflow-bundle",
    contentType: "text/javascript; charset=utf-8",
  });
  const assets = await Promise.all(
    (workflow.uiCatalog?.assets ?? []).map(async ({ code, ...asset }) => {
      const stored = await weft.engine.blobs.put(code, {
        kind: "ui-bundle",
        contentType: "text/javascript; charset=utf-8",
      });
      if (stored.hash !== asset.hash) throw new Error(`UI asset hash mismatch for ${asset.id}`);
      return { ...asset, blobRef: stored.hash };
    }),
  );
  const manifest = retainedManifest.parse({
    format: 1,
    name: workflow.name,
    bundleRef: bundle.hash,
    executableHash: workflow.hash,
    ...(workflow.uiCatalog ? { uiCatalog: { buildHash: workflow.uiCatalog.buildHash, assets } } : {}),
  });
  const data = JSON.stringify(manifest);
  const dir = join(weft.runsDir, runId);
  await mkdir(dir, { recursive: true });
  // Link a fully written temporary file into place without overwriting another writer.
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(file, "utf8")) !== data) {
        throw new StepError(
          "recovery_required",
          `run ${runId}: retained workflow provenance already exists and differs; refusing to replace it`,
        );
      }
    }
    const directory = await open(dir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary);
  }
}

/**
 * Load original bundled workflow/relative modules even after source edits/removal.
 * Absence alone means an old run has no retained provenance. Corruption, unavailable
 * dependencies, and dependency drift are recovery failures, never current-ref fallback.
 * Hosts must pair this result with core resume mode "strict" to check the run journal.
 */
export async function retainedDefOf(weft: Weft, runId: string): Promise<PersistedDef | undefined> {
  const file = manifestPath(weft, runId);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = retainedManifest.safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new StepError("recovery_required", `run ${runId}: invalid retained workflow provenance`);
  const manifest = parsed.data;
  const code = await weft.engine.blobs.getText(manifest.bundleRef);
  const allowBare = mergedAllowBare(weft.config);
  const currentHash = await fingerprintBundle(code, { ...(allowBare ? { allowBare } : {}) });
  if (currentHash !== manifest.executableHash) {
    throw new StepError(
      "recovery_required",
      `run ${runId}: retained resume refused changed external dependencies or runtime; restore the recorded environment or inspect current-source edit-tolerant resume`,
      {
        detail: { recordedBundle: manifest.executableHash, currentBundle: currentHash },
      },
    );
  }
  const loaded = await instantiateBundle(code, {
    filename: file,
    expectedHash: manifest.executableHash,
    ...(allowBare ? { allowBare } : {}),
  });
  const def =
    loaded.meta.name === manifest.name
      ? loaded
      : Object.freeze({
          kind: loaded.kind,
          meta: Object.freeze({ ...loaded.meta, name: manifest.name }),
          run: loaded.run,
        });
  const uiCatalog = manifest.uiCatalog
    ? {
        buildHash: manifest.uiCatalog.buildHash,
        assets: await Promise.all(
          manifest.uiCatalog.assets.map(async ({ blobRef, ...asset }) => {
            if (blobRef !== asset.hash)
              throw new StepError("recovery_required", `run ${runId}: retained UI asset hash mismatch`);
            return { ...asset, code: await weft.engine.blobs.getText(blobRef) };
          }),
        ),
      }
    : undefined;
  return { def, hash: currentHash, ...(uiCatalog ? { uiCatalog } : {}) };
}

function manifestPath(weft: Weft, runId: string): string {
  if (!runId || runId === "." || runId === ".." || /[\\/\0]/.test(runId)) {
    throw new StepError("invalid_input", "retained workflow requires a single run ID, not a path");
  }
  return join(weft.runsDir, runId, "retained-workflow.json");
}
