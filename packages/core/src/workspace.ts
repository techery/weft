import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createGit } from "@techery/weft-git";
import {
  type CheckResult,
  type Ctx,
  type DeliveryOptions,
  StepError,
  type VerificationProof,
  type VerificationResult,
  type WorkflowDefinition,
  type WorkspaceCandidate,
  type WorkspaceOptions,
} from "@techery/weft-sdk";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { treeHash } from "./ctx.ts";
import type { JournalRecord } from "./events.ts";
import { Semaphore } from "./limiter.ts";
import { runOperation } from "./operations.ts";
import { reduceState } from "./projections.ts";
import type { RunRuntime } from "./runtime.ts";
import type { JournalStore, RunLease } from "./stores.ts";

export interface OwnedWorkspace {
  id: string;
  runId: string;
  repository: string;
  path: string;
  branch: string;
  base: string;
  configDigest: string;
  fingerprintFiles?: readonly string[];
}

export type WorkspaceEvent =
  | { type: "workspace.intent"; workspace: OwnedWorkspace }
  | { type: "workspace.ready"; workspace: OwnedWorkspace }
  | { type: "workspace.cleaned"; workspaceId: string; path: string; branch: string }
  | { type: "workspace.candidate"; candidate: WorkspaceCandidate }
  | {
      type: "verification.recorded";
      candidateId: string;
      key: string;
      passed: boolean;
      results: Readonly<Record<string, CheckResult>>;
      proofId?: string;
    }
  | { type: "delivery.completed"; candidateId: string; requestId: string; binding: string; output: unknown };

const workspaces = new WeakMap<RunRuntime, OwnedWorkspace>();
const ownedPaths = new Set<string>();
const preparations = new WeakMap<RunRuntime, NonNullable<WorkspaceOptions["prepare"]>>();
const candidates = new WeakMap<object, RunRuntime>();
const proofs = new WeakMap<object, RunRuntime>();
const locks = new WeakMap<RunRuntime, Semaphore>();
const held = new AsyncLocalStorage<RunRuntime>();

async function environmentFingerprint(workspace: OwnedWorkspace): Promise<string> {
  const files: Record<string, string | null> = Object.create(null);
  for (const path of workspace.fingerprintFiles ?? []) {
    const absolute = resolve(workspace.path, path);
    if (isAbsolute(path) || relative(workspace.path, absolute).startsWith(".."))
      throw new StepError(
        "invalid_input",
        "workspace fingerprint files must be relative paths inside the workspace",
      );
    try {
      const resolved = await realpath(absolute);
      if (relative(workspace.path, resolved).startsWith(".."))
        throw new StepError(
          "invalid_input",
          "workspace fingerprint files cannot follow symlinks outside the workspace",
        );
      files[path] = sha256Hex(await readFile(resolved));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files[path] = null;
    }
  }
  return sha256Hex(
    canonicalJson({
      config: workspace.configDigest,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      files,
    }),
  );
}

export function ownedWorkspace(rt: RunRuntime): OwnedWorkspace | undefined {
  return workspaces.get(rt);
}
export function workspacePreparation(rt: RunRuntime): NonNullable<WorkspaceOptions["prepare"]> {
  return preparations.get(rt) ?? [];
}

/** Authenticate the persisted workspace before an offline host writes a human-approved edit. */
export async function verifiedWorkspacePath(records: readonly JournalRecord[]): Promise<string | undefined> {
  const event = records.find((record) => record.ev.type === "workspace.ready")?.ev;
  if (event?.type !== "workspace.ready") {
    if (records.some((record) => record.ev.type === "workspace.intent"))
      throw new StepError(
        "recovery_required",
        "workspace preparation is incomplete; resume it before applying file edits",
      );
    return undefined;
  }
  const workspace = event.workspace;
  const run = records.find((record) => record.ev.type === "run.created")?.ev;
  if (
    run?.type !== "run.created" ||
    run.runId !== workspace.runId ||
    workspace.path !== join(workspace.repository, ".weft", "workspaces", workspace.id) ||
    records.some((record) => record.ev.type === "workspace.cleaned")
  )
    throw new StepError("recovery_required", "workspace identity is invalid or has been cleaned");
  return authenticateWorkspace(workspace);
}

async function authenticateWorkspace(workspace: OwnedWorkspace): Promise<string> {
  const source = createGit(workspace.repository);
  const block = (await source.raw(["worktree", "list", "--porcelain"])).stdout
    .split("\n\n")
    .find((entry) => entry.split("\n").includes(`worktree ${workspace.path}`));
  if (!block?.split("\n").includes(`locked weft:${workspace.runId}`))
    throw new StepError("recovery_required", "workspace registration or ownership lock is missing");
  const git = createGit(workspace.path);
  const [gitDir, common, sourceCommon, branch] = await Promise.all([
    git.raw(["rev-parse", "--git-dir"]),
    git.raw(["rev-parse", "--git-common-dir"]),
    source.raw(["rev-parse", "--git-common-dir"]),
    git.raw(["symbolic-ref", "--short", "HEAD"]),
  ]);
  const owner = JSON.parse(
    await readFile(join(resolve(workspace.path, gitDir.stdout.trim()), "weft-owner.json"), "utf8"),
  );
  if (
    canonicalJson(owner) !== canonicalJson(workspace) ||
    branch.stdout.trim() !== workspace.branch ||
    (await realpath(resolve(workspace.path, common.stdout.trim()))) !==
      (await realpath(resolve(workspace.repository, sourceCommon.stdout.trim())))
  )
    throw new StepError("recovery_required", "workspace ownership, branch, or repository changed");
  return workspace.path;
}

/** Reentrant workspace serialization; mutations cannot overtake verification or delivery. */
export function inWorkspace<T>(rt: RunRuntime, run: () => Promise<T>): Promise<T> {
  if ((!workspaces.has(rt) && !ownedPaths.has(rt.cwd)) || held.getStore() === rt) return run();
  let lock = locks.get(rt);
  if (!lock) {
    lock = new Semaphore(1);
    locks.set(rt, lock);
  }
  return lock.with(() => held.run(rt, run), rt.signal);
}

export async function prepareOwnedWorkspace(
  rt: RunRuntime,
  definition: WorkflowDefinition,
  input: unknown,
): Promise<void> {
  const history: WorkspaceEvent[] = [];
  for await (const record of rt.host.journal.read(rt.runId)) {
    if (record.ev.type === "workspace.intent" || record.ev.type === "workspace.ready")
      history.push(record.ev);
  }
  const prior = history.find(
    (event): event is Extract<WorkspaceEvent, { type: "workspace.intent" }> =>
      event.type === "workspace.intent",
  )?.workspace;
  const declaration = definition.meta.workspace;
  if (!declaration) {
    if (prior)
      throw new StepError("recovery_required", "resumed workflow removed its owned workspace declaration");
    return;
  }
  if (rt.host.testHooks?.allowWorkspace === false)
    throw new StepError("invalid_input", "owned workspaces require fixtureMode: integration");
  const config: WorkspaceOptions = typeof declaration === "function" ? declaration(input) : declaration;
  if (!config || typeof config.branch !== "string" || !config.branch.trim())
    throw new StepError("invalid_input", "workspace.branch must be a non-empty Git branch");
  if (
    config.prepare?.some(
      (command) =>
        !Array.isArray(command) ||
        !command.length ||
        command.some((part) => typeof part !== "string") ||
        !command[0],
    )
  )
    throw new StepError("invalid_input", "workspace.prepare requires non-empty argument arrays");
  const source = createGit(rt.cwd);
  await source.raw(["check-ref-format", "--branch", config.branch]);
  const repository = await realpath((await source.raw(["rev-parse", "--show-toplevel"])).stdout.trim());
  const configDigest = sha256Hex(canonicalJson(config));
  if (prior && (prior.repository !== repository || prior.configDigest !== configDigest))
    throw new StepError(
      "recovery_required",
      "workspace declaration or repository changed; inspect the retained workspace",
    );
  let workspace = prior;
  if (!workspace) {
    if (rt.dry) throw new StepError("recovery_required", "dry replay cannot create a missing workspace");
    const collision = await source.raw(["show-ref", "--verify", `refs/heads/${config.branch}`], {
      allowFailure: true,
    });
    if (collision.exitCode === 0)
      throw new StepError(
        "conflict",
        `workspace branch ${config.branch} already exists; choose a new branch`,
      );
    const base = (
      await source.raw(["rev-parse", "--verify", `${config.from ?? "HEAD"}^{commit}`])
    ).stdout.trim();
    const id = sha256Hex(`${repository}\n${rt.runId}`).slice(0, 32);
    workspace = {
      id,
      runId: rt.runId,
      repository,
      path: join(repository, ".weft", "workspaces", id),
      branch: config.branch,
      base,
      configDigest,
      ...(config.fingerprintFiles ? { fingerprintFiles: config.fingerprintFiles } : {}),
    };
    await rt.append([{ type: "workspace.intent", workspace }]);
  }
  const list = (await source.raw(["worktree", "list", "--porcelain"])).stdout;
  const registered = list
    .split("\n\n")
    .find((block) => block.split("\n").includes(`worktree ${workspace.path}`));
  if (
    history.some((event) => event.type === "workspace.ready") &&
    !registered?.split("\n").includes(`locked weft:${rt.runId}`)
  ) {
    throw new StepError("recovery_required", "owned workspace registration or ownership lock changed");
  }
  if (!registered) {
    if (history.some((event) => event.type === "workspace.ready") || rt.dry)
      throw new StepError("recovery_required", `owned workspace is missing: ${workspace.path}`);
    await mkdir(dirname(workspace.path), { recursive: true });
    await source.raw(["worktree", "add", "-b", workspace.branch, workspace.path, workspace.base]);
  }
  const git = createGit(workspace.path);
  const common = await realpath(
    resolve(workspace.path, (await git.raw(["rev-parse", "--git-common-dir"])).stdout.trim()),
  );
  const sourceCommon = await realpath(
    resolve(repository, (await source.raw(["rev-parse", "--git-common-dir"])).stdout.trim()),
  );
  if (common !== sourceCommon)
    throw new StepError("recovery_required", "owned workspace belongs to a different Git repository");
  const branch = (await git.raw(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  if (branch !== workspace.branch)
    throw new StepError(
      "recovery_required",
      `workspace branch changed to ${branch}; expected ${workspace.branch}`,
    );
  const gitDir = resolve(workspace.path, (await git.raw(["rev-parse", "--git-dir"])).stdout.trim());
  const ownerFile = join(gitDir, "weft-owner.json");
  try {
    const owner = JSON.parse(await readFile(ownerFile, "utf8")) as OwnedWorkspace;
    if (canonicalJson(owner) !== canonicalJson(workspace))
      throw new StepError("recovery_required", "workspace ownership record does not match this run");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (rt.dry || history.some((event) => event.type === "workspace.ready"))
      throw new StepError("recovery_required", "workspace ownership marker is missing");
    await writeFile(ownerFile, JSON.stringify(workspace), { flag: "wx" });
  }
  if (!rt.dry && !history.some((event) => event.type === "workspace.ready")) {
    if (!registered?.split("\n").some((line) => line === `locked weft:${rt.runId}`)) {
      await source.raw(["worktree", "lock", "--reason", `weft:${rt.runId}`, workspace.path]);
    }
    await rt.append([{ type: "workspace.ready", workspace }]);
  }
  workspaces.set(rt, workspace);
  ownedPaths.add(workspace.path);
  preparations.set(rt, config.prepare ?? []);
  rt.cwd = workspace.path;
}

function blocksWorkspaceCleanup(state: ReturnType<typeof reduceState>): boolean {
  // Failed verification and recorded PR feedback need follow-up, but neither
  // leaves an uncertain effect or prevents the owner from retiring a clean tree.
  return state.attention?.some(({ kind }) => kind !== "verification" && kind !== "delivery") ?? false;
}

/** Explicit host maintenance: remove only a clean, owned, terminal worktree; never delete its branch. */
export async function cleanupOwnedWorkspace(
  journal: JournalStore,
  runId: string,
): Promise<{ path: string; branch: string }> {
  if (!journal.acquireRun)
    throw new StepError("invalid_input", "workspace cleanup requires a journal with exclusive run leases");
  const lease = await journal.acquireRun(runId, { ttlMs: 60_000 });
  if (!lease) throw new StepError("conflict", "run is active; stop it before workspace cleanup");
  const childLeases: RunLease[] = [];
  try {
    const records = [];
    for await (const record of journal.read(runId)) records.push(record);
    const state = reduceState(records);
    if (!["complete", "failed", "cancelled"].includes(state.status))
      throw new StepError("invalid_input", "workspace cleanup requires a terminal run");
    if (blocksWorkspaceCleanup(state))
      throw new StepError("recovery_required", "resolve recovery blockers before workspace cleanup");
    const descendants = [{ id: runId, records }];
    const seen = new Set([runId]);
    for (const parent of descendants) {
      for (const record of parent.records) {
        if (record.ev.type !== "step.scheduled" || !record.ev.childRunId || seen.has(record.ev.childRunId))
          continue;
        const id = record.ev.childRunId;
        seen.add(id);
        if (!(await journal.exists(id))) continue;
        const childLease = await journal.acquireRun(id, { ttlMs: 60_000 });
        if (!childLease) throw new StepError("conflict", `child run ${id} is active; workspace retained`);
        childLeases.push(childLease);
        const childRecords: JournalRecord[] = [];
        for await (const childRecord of journal.read(id)) childRecords.push(childRecord);
        const created = childRecords.find((childRecord) => childRecord.ev.type === "run.created")?.ev;
        const childState = reduceState(childRecords);
        if (
          created?.type !== "run.created" ||
          created.parentRunId !== parent.id ||
          !["complete", "failed", "cancelled"].includes(childState.status) ||
          blocksWorkspaceCleanup(childState)
        )
          throw new StepError("recovery_required", `child run ${id} is unresolved; workspace retained`);
        descendants.push({ id, records: childRecords });
      }
    }
    const workspace = records.find((record) => record.ev.type === "workspace.ready")?.ev;
    if (workspace?.type !== "workspace.ready")
      throw new StepError("invalid_input", "run has no owned workspace");
    const owned = workspace.workspace;
    if (owned.runId !== runId || owned.path !== join(owned.repository, ".weft", "workspaces", owned.id))
      throw new StepError("recovery_required", "invalid workspace ownership path");
    if (records.some((record) => record.ev.type === "workspace.cleaned"))
      return { path: owned.path, branch: owned.branch };
    const source = createGit(owned.repository);
    const registered = (await source.raw(["worktree", "list", "--porcelain"])).stdout
      .split("\n\n")
      .find((block) => block.split("\n").includes(`worktree ${owned.path}`));
    if (!registered?.split("\n").includes(`locked weft:${runId}`))
      throw new StepError("recovery_required", "workspace registration or ownership lock is missing");
    const git = createGit(owned.path);
    const gitDir = resolve(owned.path, (await git.raw(["rev-parse", "--git-dir"])).stdout.trim());
    const owner = JSON.parse(await readFile(join(gitDir, "weft-owner.json"), "utf8"));
    if (canonicalJson(owner) !== canonicalJson(owned))
      throw new StepError("recovery_required", "workspace owner marker mismatch");
    const [branch, status, common, sourceCommon] = await Promise.all([
      git.raw(["symbolic-ref", "--short", "HEAD"]),
      git.raw(["status", "--porcelain", "--untracked-files=all", "--ignored"]),
      git.raw(["rev-parse", "--git-common-dir"]),
      source.raw(["rev-parse", "--git-common-dir"]),
    ]);
    if (branch.stdout.trim() !== owned.branch || status.stdout.trim())
      throw new StepError(
        "conflict",
        "workspace has changes, ignored files, or a changed branch; preserve them before cleanup",
      );
    if (
      (await realpath(resolve(owned.path, common.stdout.trim()))) !==
      (await realpath(resolve(owned.repository, sourceCommon.stdout.trim())))
    )
      throw new StepError("recovery_required", "workspace repository mismatch");
    if (!(await lease.refresh())) throw new StepError("conflict", "workspace cleanup lease was lost");
    await source.raw(["worktree", "unlock", owned.path]);
    try {
      await source.raw(["worktree", "remove", owned.path]);
    } catch (error) {
      await source.raw(["worktree", "lock", "--reason", `weft:${runId}`, owned.path], { allowFailure: true });
      throw error;
    }
    await journal.append(runId, [
      { type: "workspace.cleaned", workspaceId: owned.id, path: owned.path, branch: owned.branch },
    ]);
    ownedPaths.delete(owned.path);
    return { path: owned.path, branch: owned.branch };
  } finally {
    await Promise.all(childLeases.map((childLease) => childLease.release()));
    await lease.release();
  }
}

async function assertCurrent(rt: RunRuntime, candidate: WorkspaceCandidate): Promise<void> {
  const workspace = workspaces.get(rt);
  if (!workspace || candidates.get(candidate) !== rt || candidate.workspaceId !== workspace.id)
    throw new StepError("stale_candidate", "candidate was not issued for this run's workspace");
  try {
    await authenticateWorkspace(workspace);
  } catch (error) {
    throw new StepError("recovery_required", `owned workspace authentication failed: ${String(error)}`);
  }
  const git = createGit(rt.cwd);
  const [head, tree, branch, status] = await Promise.all([
    git.raw(["rev-parse", "HEAD"]),
    git.raw(["rev-parse", "HEAD^{tree}"]),
    git.raw(["symbolic-ref", "--short", "HEAD"]),
    git.raw(["status", "--porcelain", "--untracked-files=all"]),
  ]);
  if (
    status.stdout.trim() ||
    head.stdout.trim() !== candidate.head ||
    tree.stdout.trim() !== candidate.tree ||
    branch.stdout.trim() !== candidate.branch ||
    (await environmentFingerprint(workspace)) !== candidate.environment
  ) {
    throw new StepError(
      "stale_candidate",
      "workspace changed after verification; capture and verify a new committed candidate",
      { detail: { candidateId: candidate.id, expectedHead: candidate.head, actualHead: head.stdout.trim() } },
    );
  }
}

/** Adds delivery capabilities to the existing execution context and journal. */
export function attachDeliveryContext(rt: RunRuntime, ctx: Ctx): Ctx {
  const workspace = workspaces.get(rt);
  const originalCheck = ctx.check;
  ctx.operation = ((definition, input, options) =>
    inWorkspace(rt, () => runOperation(rt, definition, input, options))) as Ctx["operation"];
  ctx.verify = (async (candidate, checks, options) => {
    checks = Object.freeze(
      checks.map((check) =>
        Object.freeze({
          ...check,
          ...(check.mode === "command" && Array.isArray(check.command)
            ? { command: Object.freeze([...check.command]) }
            : {}),
        }),
      ),
    ) as typeof checks;
    options = { ...options };
    return inWorkspace(rt, async () => {
      await assertCurrent(rt, candidate);
      if (
        !options?.key ||
        checks.length === 0 ||
        new Set(checks.map((check) => check.name)).size !== checks.length
      )
        throw new StepError("invalid_input", "verify requires a key and non-empty checks with unique names");
      const results: Record<string, CheckResult> = Object.create(null);
      for (const check of checks) {
        if (check.kind !== "weft.check" || check.input)
          throw new StepError(
            "invalid_input",
            "verify expects static check definitions; bind parameters in a named check first",
          );
        results[check.name] = await originalCheck(check, {
          key: `${options.key}:${candidate.id}:${check.name}`,
          purpose: "diagnostic",
          fresh: true,
          ...(options.timeout ? { timeout: options.timeout } : {}),
        });
        await assertCurrent(rt, candidate);
      }
      const passed = Object.values(results).every(
        (result) => result.status === "pass" && result.disposition === "executed",
      );
      const id = sha256Hex(
        canonicalJson({
          candidate: candidate.id,
          checks: checks.map((check) => ({
            name: check.name,
            revision: check.revision ?? null,
            body:
              check.mode === "run"
                ? check.run.toString()
                : typeof check.command === "function"
                  ? check.command.toString()
                  : check.command,
          })),
          results,
        }),
      );
      const proof = Object.freeze({
        id,
        candidateId: candidate.id,
        checks: Object.freeze(checks.map((check) => check.name)),
      }) as unknown as VerificationProof;
      if (passed) proofs.set(proof, rt);
      await rt.append([
        {
          type: "verification.recorded",
          candidateId: candidate.id,
          key: rt.resolveKey(options.key)!,
          passed,
          results,
          ...(passed ? { proofId: id } : {}),
        },
      ]);
      return Object.freeze({
        candidate,
        results: Object.freeze(results),
        passed,
        ...(passed ? { proof } : {}),
      }) as VerificationResult;
    });
  }) as Ctx["verify"];
  ctx.delivery = ((definition, input, options: DeliveryOptions) =>
    inWorkspace(rt, async () => {
      options = {
        ...options,
        proofs: Object.freeze([...options.proofs]),
        ...(options.approval ? { approval: { ...options.approval } } : {}),
      };
      const valid = async () => {
        await assertCurrent(rt, options.candidate);
        if (
          !options.proofs.length ||
          options.proofs.some(
            (proof) => proofs.get(proof) !== rt || proof.candidateId !== options.candidate.id,
          )
        )
          throw new StepError(
            "check_failed",
            "delivery requires executed passing proofs for this exact candidate",
          );
      };
      await valid();
      if (options.approval) {
        const approval = await ctx.human.approve({
          key: `${options.key}:candidate:${options.candidate.id}`,
          action: options.approval.question,
          detail: `Branch ${options.candidate.branch}\nCommit ${options.candidate.head}\nCandidate ${options.candidate.id}`,
          ...(options.approval.timeout ? { timeout: options.approval.timeout } : {}),
        });
        if (!approval.approved) throw new StepError("human_denied", "candidate delivery was declined");
        await valid();
      }
      const receipt = await runOperation(rt, definition, input, options, valid, {
        candidate: options.candidate,
        checks: [...new Set(options.proofs.flatMap((proof) => proof.checks))],
      });
      await rt.append([
        {
          type: "delivery.completed",
          candidateId: options.candidate.id,
          requestId: receipt.requestId,
          binding: receipt.binding,
          output: receipt.value,
        },
      ]);
      return receipt;
    })) as Ctx["delivery"];
  if (!workspace && !ownedPaths.has(rt.cwd)) return ctx;
  if (workspace)
    Object.defineProperty(ctx, "workspace", {
      enumerable: true,
      value: Object.freeze({
        id: workspace.id,
        path: workspace.path,
        branch: workspace.branch,
        assertCurrent: (candidate: WorkspaceCandidate) => assertCurrent(rt, candidate),
        snapshot: (options: { key: string }) =>
          inWorkspace(rt, async () => {
            if (!options?.key) throw new StepError("invalid_input", "workspace.snapshot requires a key");
            return rt.runStep({
              kind: "git",
              key: options.key,
              label: "workspace candidate",
              payload: { workspace: workspace.id },
              verifyServe: async () => false,
              execute: async () => {
                const git = createGit(rt.cwd);
                if ((await git.raw(["status", "--porcelain", "--untracked-files=all"])).stdout.trim())
                  throw new StepError(
                    "stale_candidate",
                    "commit all candidate changes before snapshotting the workspace",
                  );
                const head = (await git.head()).sha;
                const tree = await treeHash(rt.cwd);
                const environment = await environmentFingerprint(workspace);
                const branch = (await git.raw(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
                if (branch !== workspace.branch)
                  throw new StepError("stale_candidate", "workspace branch changed");
                let generation = 1;
                for await (const record of rt.host.journal.read(rt.runId)) {
                  if (record.ev.type === "workspace.candidate")
                    generation = Math.max(
                      generation,
                      record.ev.candidate.generation +
                        Number(
                          record.ev.candidate.head !== head ||
                            record.ev.candidate.tree !== tree ||
                            record.ev.candidate.environment !== environment,
                        ),
                    );
                }
                const id = sha256Hex(
                  canonicalJson({ workspace: workspace.id, head, tree, environment, generation }),
                );
                const candidate = Object.freeze({
                  id,
                  runId: rt.runId,
                  workspaceId: workspace.id,
                  repository: workspace.repository,
                  branch,
                  head,
                  tree,
                  environment,
                  generation,
                }) as WorkspaceCandidate;
                candidates.set(candidate, rt);
                await rt.append([{ type: "workspace.candidate", candidate }]);
                return { value: candidate };
              },
            });
          }),
      }),
    });
  for (const name of ["exec", "bash", "integrate", "discard", "workflow"] as const) {
    const original = ctx[name] as (...args: any[]) => Promise<any>;
    (ctx as any)[name] = (...args: any[]) => inWorkspace(rt, () => original(...args));
  }
  const check = ctx.check;
  const lockedCheck = ((...args: any[]) => inWorkspace(rt, () => (check as any)(...args))) as Ctx["check"];
  for (const name of ["exec", "fn", "trust", "skip", "suite"] as const) {
    const original = (check as any)[name];
    if (typeof original === "function")
      (lockedCheck as any)[name] = (...args: any[]) => inWorkspace(rt, () => original(...args));
  }
  ctx.check = lockedCheck;
  const humanReview = ctx.human.review;
  ctx.human.review = ((...args: any[]) =>
    inWorkspace(rt, () => (humanReview as any)(...args))) as Ctx["human"]["review"];
  ctx.human.review.detailed = ((...args: any[]) =>
    inWorkspace(rt, () => (humanReview.detailed as any)(...args))) as Ctx["human"]["review"]["detailed"];
  for (const name of [
    "add",
    "commit",
    "checkout",
    "fetch",
    "pull",
    "push",
    "reset",
    "apply",
    "tag",
    "clean",
    "snapshot",
    "revert",
    "cherryPick",
  ]) {
    const original = (ctx.git as any)[name];
    if (typeof original === "function")
      (ctx.git as any)[name] = (...args: any[]) => inWorkspace(rt, () => original(...args));
  }
  for (const group of [ctx.git.branch, ctx.git.stash]) {
    for (const [name, original] of Object.entries(group)) {
      if (typeof original === "function")
        (group as any)[name] = (...args: any[]) =>
          inWorkspace(rt, () => (original as (...args: any[]) => Promise<any>)(...args));
    }
  }
  const agent = ctx.agent;
  const invoke = (fn: (...args: any[]) => Promise<any>, args: any[]) => {
    const options =
      typeof args[0] === "string"
        ? { ...rt.activeScope()?.agent, ...args[1] }
        : { ...args[0]?.defaults, ...rt.activeScope()?.agent, ...args[2] };
    return options?.write ? inWorkspace(rt, () => fn(...args)) : fn(...args);
  };
  const wrapped = ((...args: any[]) => invoke(agent, args)) as Ctx["agent"];
  wrapped.detailed = ((...args: any[]) => invoke(agent.detailed, args)) as Ctx["agent"]["detailed"];
  ctx.agent = wrapped;
  return ctx;
}
