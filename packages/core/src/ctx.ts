/**
 * buildCtx: the full authoring surface, implemented over RunRuntime.runStep().
 * Every call here is a journaled step — executed by the engine, served on replay.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { createGit, GIT_WRITE_RISK, type Git, type GitWriteOp } from "@weft/git";
import { addWorktree, applyPatchToTree, capturePatch, checkScope, removeWorktree } from "@weft/isolation";
import {
  type AgentFn,
  type AgentOptions,
  type AnySchema,
  CancelledError,
  type CheckOptions,
  type CheckResult,
  type Ctx,
  type DetailedAgentResult,
  type Duration,
  type ExecOptions,
  type ExecResult,
  type FetchOptions,
  type GitApi,
  type GitRange,
  type GitWriteOpts,
  type InferOut,
  type IntegrateOptions,
  type IntegrationLedger,
  isCancellation,
  type NoteInput,
  type ParallelOptions,
  type ParallelTask,
  type PatchRef,
  type Pipeline,
  parseDuration,
  type Risk,
  type SecretHandle,
  type Settled,
  StepError,
  type SubWorkflowOptions,
  type Usage,
  validateSchema,
  type WorkflowDefinitionLike,
} from "@weft/sdk";
import { execa } from "execa";
import picomatch from "picomatch";
import { glob as tinyGlob } from "tinyglobby";
import * as z from "zod";
import { priceFor } from "./config.ts";
import type { BlobRefJson } from "./events.ts";
import { toWireSchema, unwrapWireValue } from "./jsonschema.ts";
import { mapWithConcurrency } from "./limiter.ts";
import type { AgentRequest, AgentResult } from "./provider.ts";
import { MAX_TIMER_MS, type RunRuntime, type StepIO, sleep as sleepMs } from "./runtime.ts";

const RISK_ORDER: Risk[] = ["low", "medium", "high", "irreversible"];

function maxRisk(a: Risk, b: Risk | undefined): Risk {
  if (!b) return a;
  return RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a;
}

function toMs(d: Duration | undefined, fallback: number): number {
  return d === undefined ? fallback : parseDuration(d);
}

function tail(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/**
 * AbortSignal.timeout past Node's ~24.8-day timer ceiling fires IMMEDIATELY
 * (the overflowed delay clamps to 1ms), aborting a long-deadline fetch on the
 * spot. Chunk the countdown the same way sleep() does; unref'd so a pending
 * deadline never holds the process open.
 */
function timeoutSignalOf(ms: number): AbortSignal {
  if (ms <= MAX_TIMER_MS) return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const deadline = Date.now() + ms;
  const arm = (): void => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      return;
    }
    setTimeout(arm, Math.min(remaining, MAX_TIMER_MS)).unref?.();
  };
  arm();
  return controller.signal;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function isSecretHandle(v: unknown): v is SecretHandle {
  return typeof v === "object" && v !== null && typeof (v as SecretHandle).__weftSecret === "string";
}

/** Journal-safe view of an env/header map: secret handles become `<redacted:NAME>`. Never touches env. */
function journalSecretMap(map: Record<string, string | SecretHandle> | undefined): Record<string, string> {
  const journalSafe: Record<string, string> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    journalSafe[k] = isSecretHandle(v) ? `<redacted:${v.__weftSecret}>` : v;
  }
  return journalSafe;
}

/**
 * Resolve secret handles engine-side at CALL time — invoked only inside a live
 * execute(), never before the journal lookup, so a journal-served step resumes
 * fine in an environment where the secret is no longer set.
 */
function resolveSecretValues(
  map: Record<string, string | SecretHandle> | undefined,
  ref: { key?: string; kind?: string },
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    if (isSecretHandle(v)) {
      const name = v.__weftSecret;
      const value = process.env[name];
      if (value === undefined) {
        throw new StepError("invalid_input", `secret "${name}" is not set in the engine environment`, {
          step: ref,
        });
      }
      resolved[k] = value;
    } else {
      resolved[k] = v;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Tree hashing (patch idempotency)
// ---------------------------------------------------------------------------

/** Content hash of the full working tree (tracked + untracked, minus ignored). */
export async function treeHash(cwd: string): Promise<string> {
  const indexFile = join(tmpdir(), `weft-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    // Seed from HEAD first (same reason as integrationBaseCommit below): on an empty
    // index a tracked file that .gitignore also matches would drop out of the hash,
    // and integrate's idempotency check would go blind to changes in it.
    await execa("git", ["read-tree", "HEAD"], { cwd, env });
    await execa("git", ["add", "-A", "."], { cwd, env });
    const { stdout } = await execa("git", ["write-tree"], { cwd, env });
    return stdout.trim();
  } finally {
    await nodeFs.rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/**
 * Materialize the CURRENT integration state — tracked and untracked, including
 * changes an earlier ctx.integrate() left uncommitted — as a dangling commit,
 * without touching HEAD, the real index, or the working tree. Write-step
 * worktrees seed from it (so later agents build on earlier integrations), and
 * conflict rollbacks restore from it (so a user's pre-existing untracked file is
 * restored, never deleted as if the patch had created it). Returns HEAD when the
 * tree is already identical to it.
 */
export async function integrationBaseCommit(cwd: string, alsoInclude: string[] = []): Promise<string> {
  const indexFile = join(tmpdir(), `weft-index-${randomUUID()}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: "weft-engine",
    GIT_AUTHOR_EMAIL: "engine@weft.invalid",
    GIT_COMMITTER_NAME: "weft-engine",
    GIT_COMMITTER_EMAIL: "engine@weft.invalid",
  };
  try {
    // Seed from HEAD first: on an empty index a tracked file that .gitignore also
    // matches would look untracked to `add -A` and silently drop out of the tree.
    await execa("git", ["read-tree", "HEAD"], { cwd, env });
    await execa("git", ["add", "-A", "."], { cwd, env });
    // A rollback restores its caller's target paths FROM this snapshot: a
    // pre-existing IGNORED file at one of those paths is skipped by `add -A`,
    // so the rollback would read it as patch-created and DELETE the user's
    // original. Force the named collision targets in (existing paths only —
    // `add -f` fails on a pathspec matching nothing).
    const present: string[] = [];
    for (const file of alsoInclude) {
      if (
        await nodeFs.lstat(join(cwd, file)).then(
          () => true,
          () => false,
        )
      )
        present.push(file);
    }
    if (present.length > 0) await execa("git", ["add", "-f", "--", ...present], { cwd, env });
    const tree = (await execa("git", ["write-tree"], { cwd, env })).stdout.trim();
    const head = (await execa("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    const headTree = (await execa("git", ["rev-parse", "HEAD^{tree}"], { cwd })).stdout.trim();
    if (tree === headTree) return head;
    const { stdout } = await execa(
      "git",
      ["commit-tree", tree, "-p", head, "-m", "weft integration snapshot"],
      {
        cwd,
        env,
      },
    );
    return stdout.trim();
  } finally {
    await nodeFs.rm(indexFile, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// buildCtx
// ---------------------------------------------------------------------------

export function buildCtx(rt: RunRuntime): Ctx {
  const config = rt.host.config;
  const gitHandle: Git = createGit(rt.cwd);

  const resolveInCwd = (p: string): string => (isAbsolute(p) ? p : resolvePath(rt.cwd, p));

  // ---- agent --------------------------------------------------------------

  async function agentImpl<S extends AnySchema>(
    prompt: string,
    opts: AgentOptions<S>,
    mode: { detailed: boolean; writeInPlace?: boolean },
  ): Promise<unknown> {
    if (!opts?.schema) {
      throw new StepError("invalid_input", "ctx.agent: 'schema' is required on every step", {
        step: { kind: "agent" },
      });
    }
    const wire = toWireSchema(opts.schema);
    const providerId = opts.provider ?? rt.workflowDefaults.provider ?? config.defaults.provider;
    // step opts → workflow defaults → engine config; a model default applies only
    // when the step actually routes to the provider that default was written for.
    const wfProvider = rt.workflowDefaults.provider ?? config.defaults.provider;
    const model =
      opts.model ??
      (providerId === wfProvider ? rt.workflowDefaults.model : undefined) ??
      (providerId === config.defaults.provider ? config.defaults.model : undefined);
    const effort = opts.effort ?? rt.workflowDefaults.effort ?? config.defaults.effort;
    const maxTurns = opts.maxTurns ?? config.limits.maxTurns;
    const timeoutMs = toMs(opts.timeout, config.limits.stepTimeoutMs);
    const repairMax = opts.repair ?? config.limits.repair;
    const useWorktree = !mode.writeInPlace && (opts.isolation === "worktree" || opts.write !== undefined);
    const ordinal = rt.nextAgentOrdinal();
    const label = opts.label ?? opts.key ?? `${rt.currentPhase ?? "run"}/agent#${ordinal}`;
    const scope = opts.write
      ? {
          paths: opts.write.paths,
          ...(opts.write.also ? { also: opts.write.also } : {}),
          mode: opts.write.mode ?? ("warn" as const),
        }
      : undefined;

    const payload = {
      prompt,
      provider: providerId,
      model: model ?? null,
      effort: effort ?? null,
      maxTurns,
      timeoutMs,
      isolation: useWorktree ? "worktree" : "none",
      write: scope ?? null,
    };

    const stepRef = { kind: "agent", key: opts.key, label, runId: rt.runId };

    const reviveDetailed = async (
      journaled: unknown,
      entry?: { usage?: Usage; sessionId?: string; attempts?: number },
    ) => {
      const out = journaled as { value: unknown; files: string[]; patch: PatchRef | null };
      const check = await validateSchema(opts.schema, out.value);
      if (!check.ok) {
        throw new StepError(
          "invalid_output",
          `journaled output no longer satisfies the schema for ${label}`,
          {
            step: stepRef,
          },
        );
      }
      const detailed: DetailedAgentResult<InferOut<S>> = {
        value: check.value,
        usage: entry?.usage ?? { input: 0, output: 0 },
        files: out.files ?? [],
        ...(out.patch ? { patch: out.patch } : {}),
        attempts: entry?.attempts ?? 1,
        ...(entry?.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      };
      return detailed;
    };

    const run = () =>
      rt.runStep<DetailedAgentResult<InferOut<S>>>({
        kind: "agent",
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        label,
        payload,
        schemaJson: wire.json,
        ...(opts.retry
          ? { retry: { attempts: opts.retry.attempts, backoffMs: toMs(opts.retry.backoff, 1_000) } }
          : {}),
        // Engine-side guard: a short grace lets a well-behaved provider fail with
        // its own richer error first; a provider that ignores timeoutMs is aborted.
        timeoutMs: timeoutMs + 1_000,
        route: { provider: providerId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
        ...(scope ? { scope } : {}),
        revive: (journaled, entry) => reviveDetailed(journaled, entry),
        onSettle: (value) => {
          if (value.patch) {
            rt.patches.set(value.patch.key, {
              key: value.patch.key,
              ref: value.patch.ref,
              files: value.patch.files,
              quarantined: value.patch.quarantined ?? false,
              outOfScope: value.patch.outOfScope ?? [],
              integrated: false,
              discarded: false,
            });
          }
        },
        execute: async (io) => {
          rt.bumpAgentCount(stepRef);

          let workCwd = rt.cwd;
          let worktree: { path: string; base: string } | undefined;
          // Reserved, not just checked: parallel dispatches against one pool must not
          // all sail past a nearly-dry ceiling before the first charge lands.
          const releaseCall = rt.budget.reserveCall(stepRef);
          try {
            if (useWorktree) {
              // Per-ATTEMPT path: a retry after a timeout must never remove and
              // recreate the directory a hung previous attempt may still write to.
              const dir = join(tmpdir(), "weft-worktrees", rt.runId, `${io.seq}.${io.attempt}`);
              // A process killed mid-step leaves this seq's directory registered as a
              // worktree; without clearing it, every resume of the step would fail at
              // `git worktree add`. removeWorktree prunes and tolerates absence.
              await removeWorktree({ repoRoot: rt.cwd, path: dir });
              // Seed from the CURRENT integration state, not HEAD: patches merged by
              // an earlier ctx.integrate() are uncommitted in the tree, and a later
              // write agent must build on them.
              worktree = await addWorktree({
                repoRoot: rt.cwd,
                dir,
                baseRef: await integrationBaseCommit(rt.cwd),
              });
              workCwd = worktree.path;
            }
            // An in-place writer edits the integration tree directly — no worktree,
            // no patch capture — so its declared scope needs its own record:
            // snapshot the tree now and diff after the dispatch to see what was
            // REALLY touched (a sandbox like Codex's permits the whole repo).
            // Ignored paths are invisible to the snapshots (standard excludes), so
            // list them separately: a resolver dropping a NEW ignored file out of
            // scope must still be caught.
            let inPlaceSnap: string | undefined;
            let ignoredListingBefore: string[] | undefined;
            let ignoredBefore: Set<string> | undefined;
            let ignoredManifestBefore: Map<string, string> | undefined;
            if (mode.writeInPlace && scope) {
              inPlaceSnap = await integrationBaseCommit(workCwd);
              ignoredListingBefore = await listIgnoredFiles();
              ignoredBefore = new Set(ignoredListingBefore);
              // The listing diff only sees NEW top-level entries; edits (or new
              // files) INSIDE a pre-existing ignored file or directory need a
              // stat manifest to become visible at all.
              ignoredManifestBefore = await ignoredStatManifest(ignoredListingBefore);
            }
            let finalPrompt = prompt;
            if (scope) {
              const also = scope.also?.length
                ? `\nAlso allowed (incidental files): ${scope.also.join(", ")}`
                : "";
              finalPrompt +=
                `\n\n## Write scope\nYou may modify only files matching: ${scope.paths.join(", ")}.${also}` +
                `\nYou are not alone in the codebase: other agents work in parallel scopes — confine every edit to yours.`;
            } else if (!mode.writeInPlace) {
              finalPrompt += `\n\nThis is a read-only step: do not modify any files.`;
            }

            const provider = rt.host.providers.get(providerId);
            // A USD-only ceiling with no way to price this call would charge $0 per
            // call forever — refuse the dispatch instead of silently unbounding it.
            if (
              rt.budget.remainingUsd() !== null &&
              rt.budget.remainingTokens() === null &&
              !provider.capabilities().reportsUsd &&
              priceFor(config, providerId, model) === undefined
            ) {
              throw new StepError(
                "invalid_input",
                `${label}: the run has a USD budget, but provider "${providerId}" reports no cost and ` +
                  `no price is configured for ${model ?? "its default model"} — configure pricing or add a token ceiling`,
                { step: stepRef },
              );
            }
            const req: AgentRequest = {
              prompt: finalPrompt,
              cwd: workCwd,
              schema: wire.json,
              label,
              ...(opts.key !== undefined ? { key: opts.key } : {}),
              ...(model !== undefined ? { model } : {}),
              ...(effort !== undefined ? { effort: effort as never } : {}),
              maxTurns,
              timeoutMs,
              onMaxTurns: opts.onMaxTurns ?? "finalize",
              tools: { allowEdits: scope !== undefined || mode.writeInPlace === true },
              ...(scope
                ? {
                    writeScope: {
                      paths: scope.paths,
                      mode: scope.mode,
                      ...(scope.also ? { also: scope.also } : {}),
                    },
                  }
                : {}),
              hitl: {
                onPermission: async (permReq) => {
                  // A zombie attempt (abandoned after its timeout) must not open
                  // gates: the step already failed and the run may have moved on.
                  if (io.signal.aborted) return { behavior: "deny", message: "attempt aborted" };
                  const risk = permReq.risk;
                  if (risk === "high" || risk === "irreversible") {
                    const gate = await rt.gateStep({
                      action: `agent tool ${permReq.tool} (${label})`,
                      risk,
                      detail: JSON.stringify(permReq.input).slice(0, 500),
                    });
                    return gate.approved
                      ? { behavior: "allow" }
                      : { behavior: "deny", message: gate.note ?? "denied" };
                  }
                  return { behavior: "allow" };
                },
                onAsk: async (question, schemaJson) => {
                  // Same fence as onPermission: an abandoned attempt must not
                  // journal a human request the run will never answer.
                  if (io.signal.aborted) {
                    throw new CancelledError(`${label}: attempt aborted`, stepRef);
                  }
                  const outcome = await rt.runHuman({
                    kind: "ask",
                    question,
                    schemaJson: schemaJson ?? { type: "object", additionalProperties: true },
                  });
                  return outcome.answer;
                },
              },
            };

            const chargeUsage = (u: Usage, opts: { journal?: boolean } = {}): Usage => {
              const usage: Usage = { ...u };
              if (usage.usd === undefined) {
                const price = priceFor(config, providerId, model);
                if (price) {
                  usage.usd =
                    (usage.input / 1e6) * price.inputPer1M + (usage.output / 1e6) * price.outputPer1M;
                }
              }
              rt.budget.charge(usage);
              if (opts.journal !== false) {
                void rt.append([
                  { type: "budget.sampled", tokens: rt.budget.spentTokens(), usd: rt.budget.spentUsd() },
                ]);
              }
              return usage;
            };

            let result: Awaited<ReturnType<typeof runProviderWithRepair>>;
            try {
              result = await rt.host.globalLimiter.with(
                () =>
                  rt.host
                    .providerLimiter(providerId)
                    .with(() => runProviderWithRepair(provider, req, io), io.signal),
                io.signal,
              );
            } catch (err) {
              // Turns preceding a failure still cost money: charge the accumulated
              // usage the repair loop attached before rethrowing — and write the
              // priced value back onto the error, so the step.attempt / step.failed
              // record carries exactly what was charged for the resume-time restore.
              const failed = err as { detail?: { usage?: Usage } };
              const carried = failed.detail?.usage;
              // Request-priced providers can report a paid failure as USD alone
              // (input/output both 0): that spend is just as real.
              if (carried && (carried.input > 0 || carried.output > 0 || (carried.usd ?? 0) > 0)) {
                // An aborted attempt may already be abandoned: charge, don't journal.
                const priced = chargeUsage(carried, { journal: !io.signal.aborted });
                failed.detail = { ...failed.detail, usage: priced };
              }
              throw err;
            }

            // The attempt may have been ABANDONED: its timeout already failed the
            // step (past the bounded drain) and the run has moved on — possibly to
            // a retry or a terminal state whose lease is released. Nothing this
            // zombie does may be observable: charge the spend in memory (the money
            // is gone either way) but journal nothing, capture nothing, and stop.
            if (io.signal.aborted) {
              chargeUsage(result.usage, { journal: false });
              throw new CancelledError(`${label}: attempt abandoned after its timeout`, stepRef);
            }
            const usage = chargeUsage(result.usage);

            // Everything past the charge is bookkeeping on a PAID call: if any of
            // it fails, the error must still carry the spend so step.attempt /
            // step.failed journal it — otherwise a resume restores a budget that
            // never saw this call and reruns it against an artificially low total.
            try {
              let transcriptRef: BlobRefJson | undefined;
              if (result.result.transcript) {
                const blob = await rt.host.blobs.put(result.result.transcript, { kind: "transcript" });
                transcriptRef = { $blob: blob.hash, size: blob.size };
              }

              let patch: PatchRef | null = null;
              let files: string[] = result.result.filesTouched ?? [];
              if (worktree && scope) {
                const captured = await capturePatch({ worktreePath: worktree.path });
                files = captured.files;
                if (captured.patch.length > 0) {
                  const blob = await rt.host.blobs.put(captured.patch, { kind: "patch" });
                  const { outOfScope } = checkScope(captured.files, scope);
                  const quarantined = scope.mode === "strict" && outOfScope.length > 0;
                  const patchKey = opts.key ?? label;
                  patch = {
                    ref: blob.hash,
                    key: patchKey,
                    files: captured.files,
                    ...(quarantined ? { quarantined } : {}),
                    ...(outOfScope.length > 0 ? { outOfScope } : {}),
                  };
                  await rt.append([
                    {
                      type: "patch.captured",
                      seq: io.seq,
                      key: patchKey,
                      ref: blob.hash,
                      files: captured.files,
                      ...(outOfScope.length > 0 ? { outOfScope } : {}),
                    },
                    ...(outOfScope.length > 0
                      ? [
                          {
                            type: "scope.violation",
                            seq: io.seq,
                            key: patchKey,
                            files: outOfScope,
                            mode: scope.mode,
                          } as const,
                        ]
                      : []),
                  ]);
                }
              } else if (inPlaceSnap !== undefined && scope) {
                // The tree diff is the authoritative record of an in-place writer's
                // edits (the provider's self-report is advisory). Under a strict
                // scope, stray edits are ROLLED BACK, not just reported — the
                // declared scope is enforced, whatever the sandbox permitted.
                // NEW ignored files come from the separate listing — the snapshots
                // can't see them. (Edits INSIDE a pre-existing ignored file or
                // directory stay out of reach of a tree diff.)
                const afterSnap = await integrationBaseCommit(workCwd);
                const newIgnored = (await listIgnoredFiles()).filter((f) => !ignoredBefore?.has(f));
                // Pre-existing ignored content re-walked with the SAME entry list:
                // an edit, deletion, or new file inside an already-ignored path is
                // invisible to both the tree diff and the listing diff.
                const changedIgnored =
                  ignoredManifestBefore !== undefined && ignoredListingBefore !== undefined
                    ? diffIgnoredManifest(
                        ignoredManifestBefore,
                        await ignoredStatManifest(ignoredListingBefore),
                      )
                    : [];
                if (changedIgnored.length > 0) {
                  await rt.append([
                    {
                      type: "scope.violation",
                      seq: io.seq,
                      key: opts.key ?? label,
                      files: changedIgnored,
                      mode: scope.mode,
                    },
                  ]);
                  if (scope.mode === "strict") {
                    // No snapshot holds ignored content, so there is nothing to
                    // restore FROM: failing loudly beats laundering the edit into
                    // a completed result — or deleting a user's pre-existing file.
                    throw new StepError(
                      "scope_violation",
                      `in-place step modified pre-existing ignored path(s) with no restorable snapshot: ${changedIgnored.join(", ")}`,
                      { step: stepRef },
                    );
                  }
                  files = [...files, ...changedIgnored];
                }
                if (afterSnap !== inPlaceSnap || newIgnored.length > 0) {
                  const changed =
                    afterSnap !== inPlaceSnap
                      ? (await gitHandle.raw(["diff", "--name-only", inPlaceSnap, afterSnap])).stdout
                          .split("\n")
                          .map((f) => f.trim())
                          .filter((f) => f !== "")
                      : [];
                  files = [...changed, ...newIgnored];
                  const { outOfScope } = checkScope(files, scope);
                  if (outOfScope.length > 0) {
                    if (scope.mode === "strict") {
                      await restorePatchFiles(inPlaceSnap, outOfScope);
                      files = files.filter((f) => !outOfScope.includes(f));
                    }
                    await rt.append([
                      {
                        type: "scope.violation",
                        seq: io.seq,
                        key: opts.key ?? label,
                        files: outOfScope,
                        mode: scope.mode,
                      },
                    ]);
                  }
                }
              }

              // Journal the RAW wire value; both live and replay paths validate from raw,
              // so schema transforms apply exactly once.
              const journalOutput = { value: result.raw, files, patch };
              const detailed: DetailedAgentResult<InferOut<S>> = {
                value: result.validated as InferOut<S>,
                usage,
                files,
                ...(patch ? { patch } : {}),
                attempts: result.attempts,
                ...(result.result.sessionId !== undefined ? { sessionId: result.result.sessionId } : {}),
              };
              return {
                value: detailed,
                journalOutput,
                usage,
                ...(result.result.sessionId !== undefined ? { sessionId: result.result.sessionId } : {}),
                ...(transcriptRef !== undefined ? { transcriptRef } : {}),
                ...(patch ? { patchRef: patch.ref } : {}),
                attempts: result.attempts,
              };
            } catch (err) {
              const failed = StepError.from(err, stepRef);
              const carried = (failed.detail as { usage?: Usage } | undefined)?.usage;
              if (carried === undefined) {
                (failed as { detail?: unknown }).detail = {
                  ...(typeof failed.detail === "object" && failed.detail !== null ? failed.detail : {}),
                  usage,
                };
              }
              throw failed;
            }
          } finally {
            releaseCall();
            // Cleanup must never veto a paid, journaled result: a stale worktree
            // is pruned by the next resume's pre-clean above.
            if (worktree)
              await removeWorktree({ repoRoot: rt.cwd, path: worktree.path }).catch(() => undefined);
          }
        },
      });

    async function runProviderWithRepair(
      provider: ReturnType<typeof rt.host.providers.get>,
      req: AgentRequest,
      io: StepIO,
    ): Promise<{ result: AgentResult; raw: unknown; validated: unknown; attempts: number; usage: Usage }> {
      // Every provider turn costs real tokens — the initial call AND each repair —
      // so usage accumulates across turns, and turns preceding a failure are
      // charged too (the exhausted/error throws carry the spend for the caller).
      const used: Usage = { input: 0, output: 0 };
      // Each turn normalizes on its own: a malformed turn reporting a NEGATIVE
      // component would otherwise subtract spend earlier turns really burned,
      // and Budget.charge's clamp only sees the already-corrupted sum.
      const positive = (v: number | undefined): number =>
        typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
      const addUsage = (u: Usage | undefined) => {
        if (!u) return;
        used.input += positive(u.input);
        used.output += positive(u.output);
        if (u.cacheRead !== undefined) used.cacheRead = (used.cacheRead ?? 0) + positive(u.cacheRead);
        if (u.usd !== undefined) used.usd = (used.usd ?? 0) + positive(u.usd);
      };
      let attempts = 1;
      let result: AgentResult;
      try {
        result = await provider.run(req, { signal: io.signal });
      } catch (err) {
        if (isCancellation(err) || err instanceof StepError) throw err;
        // A provider that failed AFTER burning turns (say, no structured output
        // ever arrived) reports the spend on the error — fold it in so the
        // failure record carries what this call really cost.
        addUsage((err as { usage?: Usage }).usage);
        throw new StepError("provider_error", `${providerId}: ${(err as Error).message}`, {
          step: stepRef,
          cause: err,
          ...(used.input > 0 || used.output > 0 || (used.usd ?? 0) > 0
            ? { detail: { usage: { ...used } } }
            : {}),
        });
      }
      addUsage(result.usage);
      for (;;) {
        const value = unwrapWireValue(result.output, wire.wrapped);
        const check = await validateSchema(opts.schema, value);
        if (check.ok) return { result, raw: value, validated: check.value, attempts, usage: used };
        if (attempts > repairMax) {
          throw new StepError(
            "schema_repair_exhausted",
            `${label} — schema repair exhausted (${repairMax} attempts): ${check.issues
              .map((i) => `${i.path}: ${i.message}`)
              .join("; ")}`,
            { step: stepRef, attempts, detail: { usage: used } },
          );
        }
        attempts++;
        await io.appendAttempt(`schema repair ${attempts - 1}/${repairMax}`);
        try {
          result = await provider.repair(result.sessionId, req, check.issues, { signal: io.signal });
        } catch (err) {
          if (isCancellation(err) || err instanceof StepError) throw err;
          // The failing repair turn's own spend rides the error too.
          addUsage((err as { usage?: Usage }).usage);
          throw new StepError("provider_error", `${providerId} repair: ${(err as Error).message}`, {
            step: stepRef,
            cause: err,
            detail: { usage: { ...used } },
          });
        }
        addUsage(result.usage);
      }
    }

    try {
      const detailed = await run();
      return mode.detailed ? detailed : detailed.value;
    } catch (err) {
      if (opts.onError === "null" && err instanceof StepError && !isCancellation(err)) {
        rt.recordDrop(err);
        return null;
      }
      throw err;
    }
  }

  const agent = (<S extends AnySchema>(prompt: string, opts: AgentOptions<S>) =>
    agentImpl(prompt, opts, { detailed: false })) as AgentFn;
  agent.detailed = <S extends AnySchema>(prompt: string, opts: AgentOptions<S>) =>
    agentImpl(prompt, opts, { detailed: true }) as Promise<DetailedAgentResult<InferOut<S>>>;

  // ---- fan-out ------------------------------------------------------------

  async function toSettled<T>(task: ParallelTask<T>): Promise<Settled<T>> {
    try {
      const value = await (typeof task === "function" ? Promise.resolve().then(task) : task);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: StepError.from(err) };
    }
  }

  async function parallel<T>(
    tasks: ReadonlyArray<ParallelTask<T>>,
    opts?: ParallelOptions,
  ): Promise<Settled<T>[]> {
    if (tasks.length > config.limits.fanoutMax) {
      // Promise-form tasks are ALREADY running — their steps spend and append.
      // Failing while they're in flight would let them journal after run.failed
      // lands (and leak unhandled rejections); settle them before surfacing.
      await Promise.allSettled(tasks.filter((t) => typeof t !== "function"));
      throw new StepError(
        "invalid_input",
        `parallel: ${tasks.length} items exceeds the cap of ${config.limits.fanoutMax}`,
      );
    }
    let settled: Settled<T>[];
    if (opts?.concurrency && tasks.every((t) => typeof t === "function")) {
      settled = await mapWithConcurrency(tasks, opts.concurrency, (t) => toSettled(t));
    } else {
      settled = await Promise.all(tasks.map((t) => toSettled(t)));
    }
    const cancelled = settled.find((s) => !s.ok && isCancellation(s.error));
    if (cancelled && !cancelled.ok) throw cancelled.error;
    return settled;
  }

  function pipeline<I>(items: ReadonlyArray<I>): Pipeline<I, I> {
    if (items.length > config.limits.fanoutMax) {
      throw new StepError(
        "invalid_input",
        `pipeline: ${items.length} items exceeds the cap of ${config.limits.fanoutMax}`,
      );
    }
    type Stage = {
      type: "step" | "filter" | "map";
      fn: (prev: unknown, item: unknown, i: number) => unknown;
    };
    const stages: Stage[] = [];
    const makeBuilder = (): Pipeline<I, unknown> => ({
      step(fn) {
        stages.push({ type: "step", fn: fn as Stage["fn"] });
        return makeBuilder() as never;
      },
      filter(fn) {
        stages.push({ type: "filter", fn: fn as Stage["fn"] });
        return makeBuilder() as never;
      },
      map(fn) {
        stages.push({ type: "map", fn: fn as Stage["fn"] });
        return makeBuilder() as never;
      },
      async run(opts?: { concurrency?: number }) {
        const lanes = await mapWithConcurrency(
          items,
          opts?.concurrency ?? (items.length || 1),
          async (item, i) => {
            let prev: unknown = item;
            try {
              for (const stage of stages) {
                if (stage.type === "filter") {
                  if (!(await stage.fn(prev, item, i))) return { filtered: true } as const;
                } else {
                  prev = await stage.fn(prev, item, i);
                }
              }
              return { ok: true, value: prev } as const;
            } catch (err) {
              return { ok: false, error: StepError.from(err) } as const;
            }
          },
        );
        const cancelled = lanes.find((l) => "ok" in l && !l.ok && isCancellation(l.error));
        if (cancelled && "error" in cancelled) throw cancelled.error;
        return lanes.filter(
          (l): l is Exclude<typeof l, { filtered: true }> => !("filtered" in l),
        ) as Settled<unknown>[];
      },
    });
    return makeBuilder() as Pipeline<I, I>;
  }

  function ok<T>(settled: ReadonlyArray<Settled<T>>): T[] {
    const values: T[] = [];
    for (const s of settled) {
      if (s.ok) values.push(s.value);
      else rt.recordDrop(s.error);
    }
    return values;
  }

  // ---- sub-workflows ------------------------------------------------------

  async function workflow(
    defOrName: WorkflowDefinitionLike<unknown, unknown> | string,
    input: unknown,
    opts: SubWorkflowOptions = {},
  ): Promise<unknown> {
    const name = typeof defOrName === "string" ? defOrName : (defOrName.meta.name ?? "inline");
    if (rt.depth + 1 > config.limits.maxDepth) {
      throw new StepError(
        "depth_exceeded",
        `sub-workflow depth limit (${config.limits.maxDepth}) exceeded at "${name}"`,
        {
          step: { kind: "workflow", key: opts.key ?? name, runId: rt.runId },
        },
      );
    }
    return rt.runStep<unknown>({
      kind: "workflow",
      ...(opts.key !== undefined ? { key: opts.key } : {}),
      label: opts.label ?? `workflow:${name}`,
      // An OMITTED input must hash differently from an explicit null: the child
      // validates {} for the former and null for the latter, so collapsing them
      // would serve a completed child's output across a real input change.
      payload: {
        workflow: name,
        input: input === undefined ? { $omitted: true } : input,
        budget: opts.budget ?? null,
      },
      reuseIncomplete: true,
      newChildRunId: () => randomUUID().slice(0, 8),
      revive: (journaled) => (journaled as { output: unknown }).output,
      execute: async (io) => {
        const result = await rt.host.executeChildRun({
          parent: rt,
          name,
          ...(typeof defOrName === "string" ? {} : { def: defOrName }),
          input,
          childRunId: io.childRunId ?? randomUUID().slice(0, 8),
          ...(opts.key !== undefined ? { key: opts.key } : {}),
          ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
          waitBridge: { markWaiting: io.markWaiting, unmarkWaiting: io.unmarkWaiting },
        });
        // The engine may have swapped a COLLIDING id for a fresh one: journal
        // the id the child actually ran under.
        return {
          value: result.output,
          journalOutput: { childRunId: result.childRunId, output: result.output },
          usage: result.usage,
        };
      },
    });
  }

  // ---- side effects -------------------------------------------------------

  const fs: Ctx["fs"] = {
    read: (path) =>
      rt.runStep({
        kind: "fs",
        payload: { op: "fs.read", path },
        label: `read:${path}`,
        execute: async () => {
          const bytes = await nodeFs.readFile(resolveInCwd(path));
          const content = bytes.toString("utf8");
          return {
            value: {
              content,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              size: bytes.byteLength,
            },
          };
        },
      }),
    glob: (patterns, opts) =>
      rt.runStep({
        kind: "fs",
        payload: { op: "fs.glob", patterns, cwd: opts?.cwd ?? null },
        label: `glob:${Array.isArray(patterns) ? patterns.join(",") : patterns}`,
        execute: async () => {
          const paths = await tinyGlob(Array.isArray(patterns) ? patterns : [patterns], {
            cwd: opts?.cwd ? resolveInCwd(opts.cwd) : rt.cwd,
            ignore: ["**/node_modules/**", "**/.git/**"],
          });
          return { value: { paths: paths.sort() } };
        },
      }),
    stat: (path) =>
      rt.runStep<import("@weft/sdk").FsStatResult>({
        kind: "fs",
        payload: { op: "fs.stat", path },
        label: `stat:${path}`,
        execute: async () => {
          try {
            const s = await nodeFs.stat(resolveInCwd(path));
            return {
              value: {
                exists: true,
                size: s.size,
                mtimeMs: s.mtimeMs,
                isFile: s.isFile(),
                isDirectory: s.isDirectory(),
              },
            };
          } catch (err) {
            // Absence is a VALUE; anything else (EACCES, ELOOP, ENAMETOOLONG…)
            // is a FAILURE — a journaled { exists: false } would replay the
            // false premise on every resume.
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") return { value: { exists: false } };
            throw new StepError("exec_failed", `stat ${path}: ${(err as Error).message}`, {
              step: { kind: "fs", key: path, runId: rt.runId },
            });
          }
        },
      }),
  };

  async function execStep(
    kind: "exec" | "bash" | "check",
    payload: Record<string, unknown>,
    label: string,
    spawn: (env: Record<string, string>, signal: AbortSignal) => ReturnType<typeof execa>,
    opts: (ExecOptions & { schema?: AnySchema }) | undefined,
    envMap?: Record<string, string | SecretHandle>,
  ): Promise<unknown> {
    const ref = { kind, key: opts?.key, label, runId: rt.runId };
    if (opts?.risk) {
      const gate = await rt.gateStep({ action: `${kind}: ${label}`, risk: opts.risk });
      if (!gate.approved) {
        throw new StepError("gate_denied", `${kind} "${label}" denied${gate.note ? `: ${gate.note}` : ""}`, {
          step: ref,
        });
      }
    }
    const reviveTyped = async (raw: ExecResult): Promise<unknown> => {
      if (!opts?.schema) return raw;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.stdout);
      } catch {
        throw new StepError(
          "exec_failed",
          `${label}: stdout is not valid JSON (exit ${raw.exitCode}): ${tail(raw.stderr || raw.stdout, 300)}`,
          {
            step: ref,
          },
        );
      }
      const check = await validateSchema(opts.schema, parsed);
      if (!check.ok) {
        throw new StepError(
          "invalid_output",
          `${label}: output failed schema validation: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
          { step: ref },
        );
      }
      return check.value;
    };
    return rt.runStep<unknown>({
      kind,
      ...(opts?.key !== undefined ? { key: opts.key } : {}),
      label,
      payload,
      ...(opts?.schema ? { schemaJson: toWireSchema(opts.schema).json } : {}),
      revive: (journaled) => reviveTyped(journaled as ExecResult),
      execute: async (io) => {
        const hooks = rt.host.testHooks;
        if (hooks) {
          const stubbed =
            kind === "bash"
              ? await hooks.bash?.(String(payload.command))
              : await hooks.exec?.(String(payload.file ?? payload.name), (payload.args as string[]) ?? []);
          if (stubbed !== undefined) {
            return { value: await reviveTyped(stubbed), journalOutput: stubbed };
          }
        }
        // Secrets resolve only on the live path; the global limiter caps every
        // effectful step, so un-capped ctx.parallel cannot fork-bomb the host.
        const resolvedEnv = resolveSecretValues(envMap, ref);
        const result = await rt.host.globalLimiter.with(() => spawn(resolvedEnv, io.signal), io.signal);
        // Cancellation must kill the RUNNING process, not just queued ones — the
        // signal rides into execa as cancelSignal; a killed command is not a
        // step failure, it is the run's cancellation.
        if (io.signal.aborted) {
          throw new CancelledError(`${label}: cancelled while running`, ref);
        }
        if (result.timedOut) {
          throw new StepError("timeout", `${label} timed out`, { step: ref });
        }
        if (result.failed && result.exitCode === undefined) {
          throw new StepError(
            "exec_failed",
            `${label}: ${tail(String(result.stderr || result.shortMessage || "spawn failed"), 400)}`,
            {
              step: ref,
            },
          );
        }
        const raw: ExecResult = {
          exitCode: result.exitCode ?? 0,
          stdout: String(result.stdout ?? ""),
          stderr: String(result.stderr ?? ""),
        };
        return { value: await reviveTyped(raw), journalOutput: raw };
      },
    });
  }

  const exec = ((file: string, args: string[] = [], opts?: ExecOptions & { schema?: AnySchema }) => {
    const timeoutMs = toMs(opts?.timeout, config.limits.execTimeoutMs);
    const cwd = opts?.cwd ? resolveInCwd(opts.cwd) : rt.cwd;
    return execStep(
      "exec",
      { op: "exec", file, args, cwd: opts?.cwd ?? null, env: journalSecretMap(opts?.env), timeoutMs },
      `${file} ${args.join(" ")}`.trim(),
      (env, signal) =>
        execa(file, args, {
          cwd,
          env: { ...process.env, ...env },
          timeout: timeoutMs,
          reject: false,
          cancelSignal: signal,
        }),
      opts,
      opts?.env,
    );
  }) as Ctx["exec"];

  const bash = ((command: string, opts?: ExecOptions & { schema?: AnySchema }) => {
    const timeoutMs = toMs(opts?.timeout, config.limits.execTimeoutMs);
    const cwd = opts?.cwd ? resolveInCwd(opts.cwd) : rt.cwd;
    return execStep(
      "bash",
      { op: "bash", command, cwd: opts?.cwd ?? null, env: journalSecretMap(opts?.env), timeoutMs },
      command,
      (env, signal) =>
        execa(command, {
          cwd,
          env: { ...process.env, ...env },
          timeout: timeoutMs,
          reject: false,
          shell: "/bin/bash",
          cancelSignal: signal,
        }),
      opts,
      opts?.env,
    );
  }) as Ctx["bash"];

  const fetchFn = ((url: string, init?: FetchOptions & { schema?: AnySchema }) => {
    const ref = { kind: "fetch", key: init?.key, runId: rt.runId };
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new StepError("invalid_input", `ctx.fetch: invalid URL "${url}"`, { step: ref });
    }
    const journalSafe = journalSecretMap(init?.headers);
    const timeoutMs = toMs(init?.timeout, config.limits.fetchTimeoutMs);
    // Normalized once: redirect rewriting compares against "POST", and native fetch
    // treats lowercase spellings as the same method anyway.
    const method = (init?.method ?? "GET").toUpperCase();
    const reviveTyped = async (raw: { status: number; headers: Record<string, string>; body: string }) => {
      if (!init?.schema) return raw;
      if (raw.status < 200 || raw.status >= 300) {
        throw new StepError("fetch_failed", `${method} ${url} → ${raw.status} (schema requested)`, {
          step: ref,
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.body);
      } catch {
        throw new StepError("fetch_failed", `${method} ${url}: body is not valid JSON`, { step: ref });
      }
      const check = await validateSchema(init.schema, parsed);
      if (!check.ok) {
        throw new StepError(
          "invalid_output",
          `${method} ${url}: body failed schema validation: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
          { step: ref },
        );
      }
      return check.value;
    };
    return rt.runStep<unknown>({
      kind: "fetch",
      ...(init?.key !== undefined ? { key: init.key } : {}),
      label: `${method} ${url}`,
      payload: { op: "fetch", url, method, headers: journalSafe, body: init?.body ?? null, timeoutMs },
      ...(init?.schema ? { schemaJson: toWireSchema(init.schema).json } : {}),
      revive: (journaled) => reviveTyped(journaled as never),
      execute: async (io) => {
        const stubbed = await rt.host.testHooks?.fetch?.(url, method);
        if (stubbed !== undefined) {
          return { value: await reviveTyped(stubbed as never), journalOutput: stubbed };
        }
        // Policy and secrets are live-path concerns: a journal-served fetch never
        // re-checks the allow-list or touches the environment.
        const allow = config.fetchAllow;
        const allowed = (host: string) => !allow || allow.some((pattern) => picomatch.isMatch(host, pattern));
        if (!allowed(hostname)) {
          throw new StepError("fetch_denied", `host "${hostname}" is not in the fetch allow-list`, {
            step: ref,
          });
        }
        const resolved = resolveSecretValues(init?.headers, ref);
        const requestInit = {
          method,
          headers: resolved,
          ...(init?.body !== undefined ? { body: init.body } : {}),
          signal: AbortSignal.any([timeoutSignalOf(timeoutMs), io.signal]),
        };
        let response: Response;
        try {
          response = await rt.host.globalLimiter.with(async () => {
            // The manual hop-by-hop path serves TWO masters: an allow-list must
            // validate every hop, and secret-backed or credential headers must be
            // stripped when a redirect crosses origins — native fetch preserves a
            // custom header like X-Api-Key across origins, leaking the resolved
            // secret. Delegate to native redirects only when NEITHER applies.
            const carriesCredentials = Object.entries(init?.headers ?? {}).some(
              ([name, v]) =>
                isSecretHandle(v) ||
                ["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase()),
            );
            if (!allow && !carriesCredentials) return globalThis.fetch(url, requestInit);
            // Redirects are followed by hand so EVERY hop is validated — native
            // fetch would silently carry an allowed host onto a forbidden (or
            // internal) one.
            let target = url;
            let hopMethod = method;
            let hopBody = init?.body;
            let hopHeaders = resolved;
            for (let hop = 0; ; hop++) {
              const res = await globalThis.fetch(target, {
                method: hopMethod,
                headers: hopHeaders,
                ...(hopBody !== undefined ? { body: hopBody } : {}),
                signal: requestInit.signal,
                redirect: "manual",
              });
              const location = res.headers.get("location");
              // Only the five statuses Fetch itself redirects on: a 304 (or any
              // other 3xx) carrying a stray Location header is returned as-is —
              // following it would contact an endpoint native fetch never would.
              if (![301, 302, 303, 307, 308].includes(res.status) || location === null) return res;
              if (hop >= 5) throw new Error(`too many redirects (stopped after ${hop + 1})`);
              const next = new URL(location, target);
              if (!allowed(next.hostname)) {
                throw new StepError(
                  "fetch_denied",
                  `redirect to "${next.hostname}" is not in the fetch allow-list`,
                  { step: ref },
                );
              }
              // Method rewriting, the way native fetch does it: 303 always becomes a
              // GET, and so does a POST answered with 301/302 — endpoints using
              // POST-then-303 must not receive a second POST.
              if (
                res.status === 303 ||
                ((res.status === 301 || res.status === 302) && hopMethod === "POST")
              ) {
                hopMethod = "GET";
                hopBody = undefined;
                hopHeaders = Object.fromEntries(
                  Object.entries(hopHeaders ?? {}).filter(
                    ([name]) => !["content-type", "content-length"].includes(name.toLowerCase()),
                  ),
                );
              }
              // Credentials are origin-bound: crossing origins drops them, the way
              // native fetch strips authorization on cross-origin redirects — and
              // EVERY header a SecretHandle backed counts as a credential, whatever
              // it is called: an X-Api-Key must not follow a redirect off-origin.
              if (next.origin !== new URL(target).origin) {
                const secretNames = new Set(
                  Object.entries(init?.headers ?? {})
                    .filter(([, v]) => isSecretHandle(v))
                    .map(([name]) => name.toLowerCase()),
                );
                hopHeaders = Object.fromEntries(
                  Object.entries(hopHeaders ?? {}).filter(([name]) => {
                    const lower = name.toLowerCase();
                    return (
                      !["authorization", "cookie", "proxy-authorization"].includes(lower) &&
                      !secretNames.has(lower)
                    );
                  }),
                );
              }
              target = next.toString();
            }
          }, io.signal);
        } catch (err) {
          if (err instanceof StepError) throw err;
          throw new StepError("fetch_failed", `${method} ${url}: ${(err as Error).message}`, {
            step: ref,
            cause: err,
          });
        }
        const body = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const raw = { status: response.status, headers, body };
        return { value: await reviveTyped(raw), journalOutput: raw };
      },
    });
  }) as Ctx["fetch"];

  const env: Ctx["env"] = {
    get: (name) =>
      rt
        .runStep({
          kind: "env",
          payload: { op: "env.get", name },
          label: `env:${name}`,
          execute: async () => {
            const value = rt.host.testHooks?.env
              ? (rt.host.testHooks.env(name) ?? null)
              : (process.env[name] ?? null);
            return { value: { value }, journalOutput: { value } };
          },
          revive: (j) => j as { value: string | null },
        })
        .then((r) => (r as { value: string | null }).value ?? undefined),
  };

  // ---- git ----------------------------------------------------------------

  async function gitHooked<T>(op: string, args: unknown, run: () => Promise<T>): Promise<T> {
    const hook = rt.host.testHooks?.git;
    if (hook) {
      const hooked = await hook(op, args);
      if (hooked !== undefined) return hooked as T;
    }
    return run();
  }

  function gitRead<T>(op: string, args: unknown, run: () => Promise<T>): Promise<T> {
    return rt.runStep<T>({
      kind: "git",
      label: `git.${op}`,
      payload: { op: `git.${op}`, args: args ?? null },
      execute: async () => ({ value: await gitHooked(op, args, run) }),
    });
  }

  async function gitWrite<T>(
    op: GitWriteOp,
    action: string,
    args: unknown,
    opts: GitWriteOpts | undefined,
    run: () => Promise<T>,
    verifyServe?: (journaled: T) => Promise<boolean>,
  ): Promise<T> {
    const risk = maxRisk(GIT_WRITE_RISK[op], opts?.risk);
    const gate = await rt.gateStep({ action, risk });
    if (!gate.approved) {
      throw new StepError("gate_denied", `${action} denied${gate.note ? `: ${gate.note}` : ""}`, {
        step: { kind: "git", key: op, runId: rt.runId },
      });
    }
    return rt.runStep<T>({
      kind: "git",
      label: action,
      payload: { op: `git.${op}`, args: args ?? null },
      ...(verifyServe && !rt.host.testHooks ? { verifyServe: (j) => verifyServe(j as T) } : {}),
      execute: async () => ({ value: await gitHooked(op, args, run) }),
    });
  }

  const git: GitApi = {
    status: () => gitRead("status", null, () => gitHandle.status()),
    head: () => gitRead("head", null, () => gitHandle.head()),
    branches: () => gitRead("branches", null, () => gitHandle.branches()),
    mergeBase: (a, b) => gitRead("mergeBase", { a, b }, () => gitHandle.mergeBase(a, b)),
    changedSince: (ref) => gitRead("changedSince", { ref }, () => gitHandle.changedSince(ref)),
    diff: async (range?: GitRange) => {
      const result = await gitRead("diff", range ?? null, () => gitHandle.diff(range));
      return result;
    },
    log: (opts) => gitRead("log", opts ?? null, () => gitHandle.log(opts)),
    show: (ref) => gitRead("show", { ref }, () => gitHandle.show(ref)),
    blame: (path, opts) => gitRead("blame", { path, ...opts }, () => gitHandle.blame(path, opts)),
    fileAt: (ref, path) => gitRead("fileAt", { ref, path }, () => gitHandle.fileAt(ref, path)),
    snapshot: () => gitRead("snapshot", null, () => gitHandle.snapshot()),

    add: (opts) =>
      gitWrite("add", "git.add", { paths: opts.paths }, opts, () => gitHandle.add({ paths: opts.paths })),
    commit: (opts) =>
      gitWrite(
        "commit",
        "git.commit",
        { message: opts.message, paths: opts.paths ?? null },
        opts,
        () => gitHandle.commit({ message: opts.message, ...(opts.paths ? { paths: opts.paths } : {}) }),
        async (journaled) => {
          if ((await gitHandle.revParse(journaled.sha)) === null) return false;
          // Object existence is not enough: after an external reset the commit
          // lingers in the object database and reflog while the branch no
          // longer contains it — the write this step promises is gone. Serve
          // only while the commit is still HEAD or an ancestor of it.
          const reach = await gitHandle.raw(["merge-base", "--is-ancestor", journaled.sha, "HEAD"], {
            allowFailure: true,
          });
          return reach.exitCode === 0;
        },
      ),
    checkout: (ref, opts) =>
      gitWrite(
        opts?.discard ? "checkout.discard" : "checkout",
        `git.checkout ${ref}${opts?.discard ? " --discard" : ""}`,
        { ref, discard: opts?.discard ?? false },
        opts,
        () => gitHandle.checkout(ref, opts?.discard ? { discard: true } : {}),
      ),
    fetch: (opts) =>
      gitWrite(
        "fetch",
        `git.fetch ${opts?.remote ?? "origin"}`,
        { remote: opts?.remote ?? "origin" },
        opts,
        () => gitHandle.fetchRemote(opts?.remote ? { remote: opts.remote } : {}),
      ),
    pull: (opts) =>
      gitWrite(
        "pull",
        `git.pull ${opts?.remote ?? "origin"}${opts?.rebase ? " --rebase" : ""}`,
        { remote: opts?.remote ?? null, branch: opts?.branch ?? null, rebase: opts?.rebase ?? false },
        opts,
        () => gitHandle.pull(opts ?? {}),
      ),
    push: (opts) =>
      gitWrite(
        opts?.force ? "push.force" : "push",
        `git.push ${opts?.remote ?? "origin"}/${opts?.branch ?? "HEAD"}${opts?.force ? " --force" : ""}`,
        {
          remote: opts?.remote ?? null,
          branch: opts?.branch ?? null,
          setUpstream: opts?.setUpstream ?? false,
          force: opts?.force ?? false,
        },
        opts,
        () => gitHandle.push(opts ?? {}),
      ),
    reset: (opts) =>
      gitWrite(
        opts.mode === "hard" ? "reset.hard" : "reset",
        `git.reset --${opts.mode ?? "mixed"} ${opts.to}`,
        { to: opts.to, mode: opts.mode ?? "mixed" },
        opts,
        () => gitHandle.reset({ to: opts.to, mode: opts.mode ?? "mixed" }),
      ),
    apply: (opts) =>
      gitWrite(
        "apply",
        "git.apply",
        { patch: sha256Of(opts.patch), threeWay: opts.threeWay ?? false },
        opts,
        () => gitHandle.applyPatch({ patch: opts.patch, threeWay: opts.threeWay ?? false }),
      ),
    tag: (name, opts) =>
      gitWrite(
        "tag",
        `git.tag ${name}`,
        { name, ref: opts?.ref ?? null },
        opts,
        () => gitHandle.tag(name, opts?.ref ? { ref: opts.ref } : {}),
        async () => (await gitHandle.revParse(name)) !== null,
      ),
    branch: {
      create: (name, opts) =>
        gitWrite(
          "branch.create",
          `git.branch.create ${name}`,
          { name, from: opts?.from ?? null, checkout: opts?.checkout ?? false },
          opts,
          () => gitHandle.branchCreate(name, opts ?? {}),
          async () => (await gitHandle.revParse(name)) !== null,
        ),
      delete: (name, opts) =>
        gitWrite(
          "branch.delete",
          `git.branch.delete ${name}`,
          { name, force: opts?.force ?? false },
          opts,
          () => gitHandle.branchDelete(name, opts ?? {}),
        ),
    },
    stash: {
      push: (opts) =>
        gitWrite("stash.push", "git.stash.push", { message: opts?.message ?? null }, opts, () =>
          gitHandle.stashPush(opts?.message ? { message: opts.message } : {}),
        ),
      pop: (opts) => gitWrite("stash.pop", "git.stash.pop", null, opts, () => gitHandle.stashPop()),
      drop: (opts) => gitWrite("stash.drop", "git.stash.drop", null, opts, () => gitHandle.stashDrop()),
    },
    clean: (opts) =>
      gitWrite("clean", "git.clean", { force: opts?.force ?? false }, opts, () =>
        gitHandle.clean(opts ?? {}),
      ),
  };

  function sha256Of(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }

  // ---- humans -------------------------------------------------------------

  const human: Ctx["human"] = {
    ask: async (opts) => {
      const wire = toWireSchema(opts.schema);
      const outcome = await rt.runHuman({
        kind: "ask",
        question: opts.question,
        ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
        schemaJson: wire.json,
        realSchema: opts.schema,
        wrapped: wire.wrapped,
        ...(opts.timeout !== undefined ? { timeoutMs: parseDuration(opts.timeout) } : {}),
        ...(timeoutSpec(opts.onTimeout) ?? {}),
      });
      return outcome.answer as never;
    },
    approve: async (opts) => {
      const outcome = await rt.runHuman({
        kind: "approve",
        question: opts.action,
        ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
        schemaJson: {
          type: "object",
          properties: { approved: { type: "boolean" }, note: { type: "string" } },
          required: ["approved"],
        },
        ...(opts.timeout !== undefined ? { timeoutMs: parseDuration(opts.timeout) } : {}),
        ...(timeoutSpec(opts.onTimeout) ?? {}),
      });
      const raw = outcome.answer as { approved?: boolean; note?: string };
      return { approved: raw.approved === true, ...(raw.note !== undefined ? { note: raw.note } : {}) };
    },
    review: async (opts) => {
      const blob = await rt.host.blobs.put(opts.artifact, { kind: "artifact" });
      const wire = toWireSchema(opts.schema);
      const outcome = await rt.runHuman({
        kind: "review",
        question: opts.question ?? "Review the attached artifact",
        schemaJson: wire.json,
        realSchema: opts.schema,
        wrapped: wire.wrapped,
        artifactRef: { $blob: blob.hash, size: blob.size, preview: opts.artifact.slice(0, 200) },
        ...(opts.timeout !== undefined ? { timeoutMs: parseDuration(opts.timeout) } : {}),
        ...(timeoutSpec(opts.onTimeout) ?? {}),
      });
      return outcome.answer as never;
    },
  };

  function timeoutSpec(
    onTimeout: "deny" | "escalate" | { default: unknown } | undefined,
  ): { onTimeout: "deny" | "escalate" | "default"; timeoutDefault?: unknown } | undefined {
    if (onTimeout === undefined) return undefined;
    if (onTimeout === "deny" || onTimeout === "escalate") return { onTimeout };
    return { onTimeout: "default", timeoutDefault: onTimeout.default };
  }

  // ---- checks, integration, ledger ---------------------------------------

  async function check(name: string, opts: CheckOptions): Promise<CheckResult> {
    const normalize = (v: boolean | CheckResult): CheckResult =>
      typeof v === "boolean" ? { status: v ? "pass" : "fail" } : v;
    const required = opts.required ?? false;
    const settle = (value: CheckResult & { required?: boolean }) => {
      if (required && value.status === "fail") rt.requiredCheckFailures.push(name);
    };
    if (opts.trustPrior) {
      return rt.runStep<CheckResult>({
        kind: "check",
        label: `check:${name}`,
        payload: { name, trustPrior: opts.trustPrior, required },
        onSettle: settle,
        execute: async () => ({
          value: {
            status: "trust-prior",
            evidence: `run ${opts.trustPrior!.run}: ${opts.trustPrior!.reason}`,
          },
        }),
      });
    }
    if (opts.exec) {
      const [file, ...args] = opts.exec;
      const timeoutMs = toMs(opts.timeout, config.limits.execTimeoutMs);
      return rt.runStep<CheckResult>({
        kind: "check",
        label: `check:${name}`,
        payload: { name, exec: opts.exec, required },
        onSettle: settle,
        execute: async (io) => {
          const stubbed = await rt.host.testHooks?.exec?.(file, args);
          const result =
            stubbed ??
            (await rt.host.globalLimiter.with(
              () =>
                execa(file, args, {
                  cwd: rt.cwd,
                  timeout: timeoutMs,
                  reject: false,
                  cancelSignal: io.signal,
                }),
              io.signal,
            ));
          const pass = result.exitCode === 0 && !("timedOut" in result && result.timedOut);
          return {
            value: {
              status: pass ? "pass" : "fail",
              evidence: tail(`${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim(), 2_000),
            },
          };
        },
      });
    }
    if (opts.fn) {
      // The same public timeout bound as exec checks — a hanging fn would
      // otherwise leave the whole run executing forever. Like exec, a timeout
      // is a FAILED check, not an aborted step.
      const timeoutMs = toMs(opts.timeout, config.limits.execTimeoutMs);
      const TIMED_OUT = Symbol("check-timeout");
      return rt.runStep<CheckResult>({
        kind: "check",
        label: `check:${name}`,
        payload: { name, fn: true, required },
        onSettle: settle,
        // A function check's real inputs live in its CLOSURE — invisible to the
        // content hash. Serving a journaled pass could vouch for an artifact a
        // diverged upstream step has since replaced, so validation re-runs on
        // every resume instead of being served.
        verifyServe: async () => false,
        execute: async () => {
          const abort = new AbortController();
          let timer: NodeJS.Timeout | undefined;
          try {
            const outcome = await Promise.race([
              Promise.resolve().then(() => opts.fn!(abort.signal)),
              new Promise<typeof TIMED_OUT>((resolve) => {
                // Chunked: Node clamps a single timer past 2^31-1ms to ~1ms,
                // which would FAIL a 30-day check almost immediately.
                const deadline = Date.now() + timeoutMs;
                const arm = (): void => {
                  const remaining = deadline - Date.now();
                  if (remaining <= 0) {
                    resolve(TIMED_OUT);
                    return;
                  }
                  timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
                };
                arm();
              }),
            ]);
            if (outcome === TIMED_OUT) {
              // Best effort: JS cannot force-kill the callback, but an abort-aware fn
              // stops here instead of appending work after the workflow moved on.
              abort.abort();
              return { value: { status: "fail", evidence: `check timed out after ${timeoutMs}ms` } };
            }
            return { value: normalize(outcome) };
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
      });
    }
    return rt.runStep<CheckResult>({
      kind: "check",
      label: `check:${name}`,
      payload: { name, skipped: true, required },
      onSettle: settle,
      execute: async () => ({ value: { status: "skipped" } }),
    });
  }

  const ResolutionSchema = z.object({
    resolution: z.enum(["skip", "keep-conflicts", "abort"]),
    note: z.string().optional(),
  });

  /** Files that still carry conflict markers — a merge agent's self-report is not proof. */
  async function conflictMarkersIn(files: string[]): Promise<string[]> {
    const marked: string[] = [];
    for (const file of files) {
      const content = await nodeFs.readFile(resolveInCwd(file), "utf8").catch(() => "");
      if (/^<{7}(?: |$)/m.test(content)) marked.push(file);
    }
    return marked;
  }

  async function restorePatchFiles(snapRef: string, files: string[]): Promise<void> {
    for (const file of files) {
      // Genuine ABSENCE from the snapshot is exit 1 (dangling object) or git's
      // explicit "not in this tree" fatals; any OTHER failure is a repository or
      // object-store error — reading it as absence would send a tracked file
      // into the deletion branch below.
      const probe = await gitHandle.raw(["cat-file", "-e", `${snapRef}:${file.replace(/\/$/, "")}`], {
        allowFailure: true,
      });
      const missingFromSnap =
        probe.exitCode === 1 || /does not exist in|exists on disk, but not in/.test(probe.stderr);
      if (probe.exitCode !== 0 && !missingFromSnap) {
        throw new StepError(
          "exec_failed",
          `rollback probe failed for ${file}: ${probe.stderr.trim() || `exit ${probe.exitCode}`}`,
          { step: { kind: "git", key: file, runId: rt.runId } },
        );
      }
      // Every rollback operation must SUCCEED: swallowing a failure here would
      // let a skipped integration continue on top of a half-applied patch.
      if (probe.exitCode === 0) {
        // Worktree-only: `checkout <ref> -- <file>` would write the INDEX too,
        // silently destroying whatever the caller had staged for this file.
        await gitHandle.raw(["restore", "--worktree", "--source", snapRef, "--", file]);
      } else {
        // recursive: a NEW ignored directory entry (from the --directory listing)
        // rolls back whole; on a plain file the flag is inert.
        await nodeFs.rm(resolveInCwd(file), { recursive: true, force: true });
      }
    }
  }

  /**
   * Untracked-IGNORED paths (standard excludes), ignored directories collapsed to
   * one entry. The in-place scope capture diffs this listing across a dispatch:
   * tree snapshots skip ignored paths entirely, so a new ignored file would
   * otherwise change nothing the snapshots can see.
   */
  async function listIgnoredFiles(): Promise<string[]> {
    const out = await gitHandle.raw(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
      { allowFailure: true },
    );
    return out.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f !== "");
  }

  /**
   * Stat manifest (path → "size:mtime") of the files under the given ignored
   * entries, walked with a cap so a giant node_modules cannot stall a step.
   * Re-walking the SAME entry list after a dispatch exposes edits, deletions,
   * and new files inside pre-existing ignored paths — content no tree snapshot
   * or listing diff can see.
   */
  const IGNORED_MANIFEST_CAP = 10_000;
  async function ignoredStatManifest(entries: string[]): Promise<Map<string, string>> {
    const manifest = new Map<string, string>();
    const walk = async (rel: string): Promise<void> => {
      if (manifest.size > IGNORED_MANIFEST_CAP) return;
      const clean = rel.replace(/\/$/, "");
      let stat: import("node:fs").Stats;
      try {
        stat = await nodeFs.stat(resolveInCwd(clean));
      } catch {
        return;
      }
      if (stat.isDirectory()) {
        let names: string[] = [];
        try {
          names = await nodeFs.readdir(resolveInCwd(clean));
        } catch {
          return;
        }
        for (const name of names.sort()) await walk(`${clean}/${name}`);
      } else {
        // Metadata is forgeable: a resolver can rewrite an ignored file with the
        // same size and a preserved (or same-millisecond) mtime. CONTENT is the
        // signature — nothing less catches every out-of-scope edit.
        try {
          manifest.set(
            clean,
            createHash("sha256")
              .update(await nodeFs.readFile(resolveInCwd(clean)))
              .digest("hex"),
          );
        } catch {
          manifest.set(clean, `unreadable:${stat.size}:${Math.floor(stat.mtimeMs)}`);
        }
      }
    };
    for (const entry of entries) await walk(entry);
    return manifest;
  }

  /** Paths whose stat changed, vanished, or appeared inside the walked entries. */
  function diffIgnoredManifest(before: Map<string, string>, after: Map<string, string>): string[] {
    const changed: string[] = [];
    for (const [path, sig] of before) {
      if (after.get(path) !== sig) changed.push(path);
    }
    for (const path of after.keys()) {
      if (!before.has(path)) changed.push(path);
    }
    return changed;
  }

  async function integrate(
    results: ReadonlyArray<DetailedAgentResult<unknown> | PatchRef>,
    opts: IntegrateOptions = {},
  ): Promise<IntegrationLedger> {
    const onConflict = opts.onConflict ?? "ask";
    const ledger: IntegrationLedger = { merged: [], conflicts: [], quarantined: [], skipped: [] };
    rt.setStatus("integrating");
    try {
      for (const result of results) {
        const patch: PatchRef | undefined =
          "ref" in result ? (result as PatchRef) : (result as DetailedAgentResult<unknown>).patch;
        if (!patch) {
          ledger.skipped.push("(no patch)");
          continue;
        }
        if (patch.quarantined) {
          ledger.quarantined.push(patch.key);
          rt.log(
            `patch ${patch.key} is quarantined (out-of-scope files: ${patch.outOfScope?.join(", ")}) — not merged`,
          );
          continue;
        }
        const outcome = await rt.runStep<{
          applied: boolean;
          conflicted?: boolean;
          baseTree: string;
          resultTree: string;
        }>({
          kind: "sideeffect",
          label: `integrate:${patch.key}`,
          payload: { op: "patch.apply", key: patch.key, ref: patch.ref, onConflict },
          verifyServe: async (journaled) => {
            const j = journaled as { applied: boolean; resultTree: string };
            if (!j.applied) return true;
            if ((await treeHash(rt.cwd)) === j.resultTree) return true;
            // Later patches moved the tree past this patch's resultTree; the merge
            // still holds if the patch content is present (it reverse-applies).
            const patchText = await rt.host.blobs.getText(patch.ref);
            const reverse = await gitHandle.raw(["apply", "--reverse", "--check"], {
              allowFailure: true,
              input: patchText,
            });
            if (reverse.exitCode === 0) return true;
            // A LATER journaled merge that started from this patch's resultTree may
            // have edited the very lines this patch introduced — the reverse check
            // fails then, but the integration is still in the chain, and reapplying
            // would conflict with or duplicate the later work.
            if (rt.replay?.mergedBaseTrees.has(j.resultTree)) return true;
            // Only an unambiguous rollback re-executes: the patch applying cleanly
            // FORWARD means the tree genuinely lacks it. Both checks failing means
            // the tree moved past it some other way — trust the journaled merge.
            const forward = await gitHandle.raw(["apply", "--check"], {
              allowFailure: true,
              input: patchText,
            });
            return forward.exitCode !== 0;
          },
          onSettle: (value) => {
            const state = rt.patches.get(patch.key);
            if (state && value.applied) state.integrated = true;
            if (state && !value.applied) state.discarded = true;
          },
          execute: async () => {
            const baseTree = await treeHash(rt.cwd);
            // Rollback snapshot must include untracked files (stash-create cannot):
            // a user's pre-existing untracked file that a patch collides with is
            // restored on skip/abort, never deleted as patch-created. The patch's
            // own targets ride along force-added, so even an IGNORED pre-existing
            // collision file is restorable rather than removed.
            const snapRef = await integrationBaseCommit(rt.cwd, patch.files);
            const patchText = await rt.host.blobs.getText(patch.ref);
            const applied = await applyPatchToTree({ repoRoot: rt.cwd, patch: patchText });
            if (applied.ok) {
              const resultTree = await treeHash(rt.cwd);
              await rt.append([
                { type: "patch.merged", key: patch.key, ref: patch.ref, baseTree, resultTree },
              ]);
              return { value: { applied: true, baseTree, resultTree } };
            }
            const conflictList = applied.conflicts.join(", ") || "(unknown files)";
            if (onConflict === "fail") {
              await restorePatchFiles(snapRef, patch.files);
              throw new StepError("conflict", `patch ${patch.key} conflicts on ${conflictList}`, {
                step: { kind: "sideeffect", key: patch.key, runId: rt.runId },
              });
            }
            if (onConflict === "agent") {
              const resolved = await agentImpl(
                `A patch (${patch.key}) was applied with 3-way merge and left conflict markers in: ${conflictList}.\n` +
                  `Resolve every conflict marker in those files, keeping both intents where possible. ` +
                  `Do not touch any other file.`,
                {
                  schema: z.object({ resolved: z.boolean(), notes: z.string() }),
                  key: `merge:${patch.key}`,
                  // Strict, and enforced: the in-place capture diffs the tree and
                  // rolls back anything the resolver touched beyond the conflicts.
                  write: { paths: applied.conflicts, mode: "strict" },
                },
                { detailed: false, writeInPlace: true },
              );
              const r = resolved as { resolved: boolean; notes: string };
              // The model's self-report is schema-valid, not authoritative: accept it
              // only when the conflicted files really carry no markers any more.
              const stillMarked = r.resolved ? await conflictMarkersIn(applied.conflicts) : [];
              if (r.resolved && stillMarked.length === 0) {
                const resultTree = await treeHash(rt.cwd);
                await rt.append([
                  {
                    type: "patch.merged",
                    key: patch.key,
                    ref: patch.ref,
                    baseTree,
                    resultTree,
                    conflicted: true,
                  },
                ]);
                return { value: { applied: true, conflicted: true, baseTree, resultTree } };
              }
              await restorePatchFiles(snapRef, [...patch.files, ...applied.conflicts]);
              const why = r.resolved
                ? `merge agent reported ${patch.key} resolved, but conflict markers remain in ${stillMarked.join(", ")}`
                : `merge agent could not resolve ${patch.key}: ${r.notes}`;
              throw new StepError("conflict", why, {
                step: { kind: "sideeffect", key: patch.key, runId: rt.runId },
              });
            }
            // onConflict === "ask"
            const wire = toWireSchema(ResolutionSchema);
            const answer = await rt.runHuman({
              kind: "ask",
              question: `Patch ${patch.key} conflicts on ${conflictList}. Resolve how?`,
              detail: `skip: drop this patch · keep-conflicts: land it with markers for later fixing · abort: fail the integration`,
              schemaJson: wire.json,
              realSchema: ResolutionSchema,
            });
            const res = (answer.answer as z.infer<typeof ResolutionSchema>).resolution;
            if (res === "keep-conflicts") {
              const resultTree = await treeHash(rt.cwd);
              await rt.append([
                {
                  type: "patch.merged",
                  key: patch.key,
                  ref: patch.ref,
                  baseTree,
                  resultTree,
                  conflicted: true,
                },
              ]);
              return { value: { applied: true, conflicted: true, baseTree, resultTree } };
            }
            await restorePatchFiles(snapRef, [...patch.files, ...applied.conflicts]);
            if (res === "abort") {
              throw new StepError("conflict", `integration aborted at ${patch.key}`, {
                step: { kind: "sideeffect", key: patch.key, runId: rt.runId },
              });
            }
            return { value: { applied: false, baseTree, resultTree: baseTree } };
          },
        });
        if (!outcome.applied) ledger.skipped.push(patch.key);
        else if (outcome.conflicted) ledger.conflicts.push(patch.key);
        else ledger.merged.push(patch.key);
      }
      return ledger;
    } finally {
      rt.setStatus("executing");
    }
  }

  async function discard(results: ReadonlyArray<DetailedAgentResult<unknown> | PatchRef>): Promise<void> {
    const patches = results
      .map((r) => ("ref" in r ? (r as PatchRef) : (r as DetailedAgentResult<unknown>).patch))
      .filter((p): p is PatchRef => p !== undefined);
    if (patches.length === 0) return;
    await rt.runStep<{ keys: string[] }>({
      kind: "sideeffect",
      label: `discard:${patches.map((p) => p.key).join(",")}`,
      payload: { op: "patch.discard", keys: patches.map((p) => p.key), refs: patches.map((p) => p.ref) },
      onSettle: () => {
        for (const p of patches) {
          const state = rt.patches.get(p.key);
          if (state) state.discarded = true;
        }
      },
      execute: async () => {
        await rt.append(patches.map((p) => ({ type: "patch.discarded", key: p.key, ref: p.ref }) as const));
        return { value: { keys: patches.map((p) => p.key) } };
      },
    });
  }

  async function note(n: NoteInput): Promise<void> {
    await rt.runStep<NoteInput>({
      kind: "sideeffect",
      label: `note:${n.kind}`,
      payload: { op: "note", ...n },
      execute: async () => {
        await rt.append([
          {
            type: "note",
            kind: n.kind,
            text: n.text,
            ...(n.evidence !== undefined ? { evidence: n.evidence } : {}),
          },
        ]);
        return { value: n };
      },
    });
  }

  // ---- durable waits & journaled randomness -------------------------------

  const signalFn = (<S extends AnySchema>(name: string, schema: S, opts?: { timeout?: Duration }) => {
    const wire = toWireSchema(schema);
    return rt.runStep<InferOut<S>>({
      kind: "signal",
      label: `signal:${name}`,
      payload: { op: "signal", name },
      schemaJson: wire.json,
      ...(opts?.timeout !== undefined ? { timeoutMs: parseDuration(opts.timeout) } : {}),
      revive: async (journaled) => {
        const check = await validateSchema(schema, journaled);
        if (!check.ok) {
          throw new StepError("invalid_output", `signal ${name}: payload failed schema validation`, {
            step: { kind: "signal", key: name, runId: rt.runId },
          });
        }
        return check.value;
      },
      execute: async (io) => {
        const payload = await rt.takeOrAwaitSignal(name, io);
        const check = await validateSchema(schema, payload);
        if (!check.ok) {
          throw new StepError(
            "invalid_output",
            `signal ${name}: payload failed schema validation: ${check.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
            { step: { kind: "signal", key: name, runId: rt.runId } },
          );
        }
        return { value: check.value, journalOutput: payload };
      },
    });
  }) as Ctx["signal"];

  async function sleepFn(duration: Duration): Promise<void> {
    const ms = parseDuration(duration);
    await rt.runStep<{ firedAt: number }>({
      kind: "sleep",
      label: `sleep:${duration}`,
      payload: { op: "sleep", ms },
      reuseIncomplete: true,
      execute: async (io) => {
        // Anchor to the ORIGINAL schedule time: a resumed sleep waits only the
        // remainder, never its full duration again.
        const deadline = (io.priorScheduledAt ?? io.scheduledAt) + ms;
        const remaining = deadline - rt.host.clock();
        if (remaining > 0) {
          io.markWaiting();
          await sleepMs(remaining, io.signal);
        }
        await rt.append([{ type: "timer.fired", seq: io.seq, deadline }]);
        return { value: { firedAt: rt.host.clock() } };
      },
    });
  }

  const nowFn = () =>
    rt
      .runStep<{ value: number }>({
        kind: "sideeffect",
        label: "now",
        payload: { op: "now" },
        execute: async () => ({ value: { value: rt.host.clock() } }),
      })
      .then((r) => r.value);

  const randomFn = () =>
    rt
      .runStep<{ value: number }>({
        kind: "sideeffect",
        label: "random",
        payload: { op: "random" },
        execute: async () => ({ value: { value: Math.random() } }),
      })
      .then((r) => r.value);

  const uuidFn = () =>
    rt
      .runStep<{ value: string }>({
        kind: "sideeffect",
        label: "uuid",
        payload: { op: "uuid" },
        execute: async () => ({ value: { value: randomUUID() } }),
      })
      .then((r) => r.value);

  // ---- assemble -----------------------------------------------------------

  const ctx: Ctx = {
    agent,
    parallel,
    pipeline,
    ok,
    workflow: workflow as Ctx["workflow"],
    gate: (req) => rt.gateStep(req),
    human,
    fs,
    exec,
    bash,
    fetch: fetchFn,
    env,
    secret: (name) => ({ __weftSecret: name }),
    git,
    check,
    integrate,
    discard,
    note,
    signal: signalFn,
    sleep: sleepFn,
    now: nowFn,
    random: randomFn,
    uuid: uuidFn,
    phase: (name) => rt.phase(name),
    log: (message) => rt.log(message),
    get budget() {
      return rt.budget.view();
    },
    run: {
      id: rt.runId,
      cwd: rt.cwd,
      ...(rt.baseRef !== undefined ? { baseRef: rt.baseRef } : {}),
      depth: rt.depth,
    },
  };
  return ctx;
}
