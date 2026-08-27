import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { StepError } from "@techery/weft-sdk";
import { sha256Hex } from "./canonical.ts";
import type { HumanReviewFileEdit, HumanReviewSubjectRef } from "./events.ts";
import type { BlobStore } from "./stores.ts";

/** Resolve an existing review file without following a workspace symlink outside cwd. */
export async function resolveReviewFile(cwd: string, path: string): Promise<string> {
  if (typeof path !== "string" || path.trim() === "" || isAbsolute(path) || path.includes("\\")) {
    throw new StepError(
      "invalid_input",
      `human.review file path must be a non-empty POSIX repository-relative path; got ${JSON.stringify(path)}`,
    );
  }
  const target = resolve(cwd, path);
  const rel = relative(cwd, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new StepError("invalid_input", `human.review file path escapes the workflow cwd: ${path}`);
  }
  const [realCwd, realTarget] = await Promise.all([fs.realpath(cwd), fs.realpath(target)]);
  const realRel = relative(realCwd, realTarget);
  if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new StepError(
      "invalid_input",
      `human.review file path escapes the workflow cwd through a symlink: ${path}`,
    );
  }
  return target;
}

/** Apply a journaled edit once; a resume accepts the already-applied after hash. */
export async function applyReviewFileEdit(
  cwd: string,
  subject: HumanReviewSubjectRef | undefined,
  edit: HumanReviewFileEdit | undefined,
  blobs: BlobStore,
): Promise<void> {
  if (edit === undefined) return;
  if (subject?.kind !== "file" || subject.mode !== "edit" || subject.path !== edit.path) {
    throw new StepError("invalid_answer", "human review answer carries an edit for a different subject");
  }
  if (subject.sha256 !== edit.beforeSha256) {
    throw new StepError("invalid_answer", "human review edit does not match the requested file revision");
  }
  const content = await blobs.getText(edit.ref.$blob);
  if (sha256Hex(content) !== edit.afterSha256) {
    throw new StepError("invalid_answer", "human review edit blob does not match its recorded hash");
  }

  const target = await resolveReviewFile(cwd, edit.path);
  const current = await fs.readFile(target);
  const currentHash = sha256Hex(current);
  if (currentHash === edit.afterSha256) return;
  if (currentHash !== edit.beforeSha256) {
    throw new StepError(
      "conflict",
      `human review could not apply ${edit.path}: file changed after the review opened`,
    );
  }

  const stat = await fs.stat(target);
  const tmp = `${target}.weft-review-${randomUUID()}`;
  try {
    await fs.writeFile(tmp, content, { mode: stat.mode });
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
