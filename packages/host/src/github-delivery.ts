import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { OperationBinding, OperationContext, ReconciledOperation } from "@techery/weft-core";
import { StepError, type WorkspaceCandidate, z } from "@techery/weft-sdk";

const exec = promisify(execFile);
export const GITHUB_REVIEWED_PR_BINDING = "github.reviewed-pr";
export const GITHUB_PR_FEEDBACK_BINDING = "github.pr-feedback";

export interface GitHubApiResponse {
  status: number;
  body: unknown;
}

/** Trusted host transport seam. Workflow definitions cannot supply this adapter. */
export interface GitHubDeliveryAdapter {
  git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string>;
  request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<GitHubApiResponse>;
}

export interface GitHubReviewedPrOptions {
  repositoryPath: string;
  owner: string;
  repo: string;
  base: string;
  /** Every named check must have an executed passing candidate-bound proof. */
  requiredChecks: readonly string[];
  remote?: string;
  /** Limits the writable remote branch namespace. Defaults to weft/. */
  branchPrefix?: string;
  /** Draft by default; only the trusted host can change publication mode. */
  draft?: boolean;
  /** Exhaustion fails closed; no absence claim is made from partial history. Defaults to 100. */
  maxPages?: number;
  /** Kept only in host memory. Git push uses the host's existing Git credentials. */
  token?: string | (() => string | Promise<string>);
  adapter?: GitHubDeliveryAdapter;
}

export interface GitHubReviewedPrReceipt {
  url: string;
  number: number;
  head: string;
  branch: string;
  repository: string;
  base: string;
  requestId: string;
  draft: boolean;
}

export interface GitHubPrFeedbackOptions {
  owner: string;
  repo: string;
  /** Remote CI names/commit-status contexts; separate from the local delivery-proof manifest. */
  requiredChecks: readonly string[];
  requiredApprovals?: number;
  maxPages?: number;
  token?: GitHubReviewedPrOptions["token"];
  adapter?: GitHubDeliveryAdapter;
}

export interface GitHubPrFeedback {
  status: "passed" | "failed" | "pending" | "unknown";
  number: number;
  head: string;
  url: string;
  draft: boolean;
  checks: Record<string, "passed" | "failed" | "pending">;
  approvals: number;
  requestedChanges: number;
  detail: string;
}

const Input = z.object({ title: z.string().trim().min(1).max(256), body: z.string().max(60_000) }).strict();
const Pull = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});
type PullRequest = z.infer<typeof Pull>;
interface PhaseRecord {
  digest: string;
  phase: "pushing" | "creating" | "created";
}

/**
 * Opt-in, same-repository GitHub delivery. An uncertain PR POST is never repeated merely
 * because a list is empty: a durable creating marker requires reconciliation or inspection.
 */
export function createGitHubReviewedPrBinding(options: GitHubReviewedPrOptions): OperationBinding {
  const opts = { ...options, requiredChecks: [...options.requiredChecks] };
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(opts.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(opts.repo) ||
    opts.repo === "." ||
    opts.repo === ".."
  ) {
    throw new TypeError("GitHub delivery requires a fixed owner and repository name");
  }
  if (
    !opts.repositoryPath ||
    !opts.base?.trim() ||
    opts.requiredChecks.length === 0 ||
    opts.requiredChecks.some((check) => !check.trim()) ||
    new Set(opts.requiredChecks).size !== opts.requiredChecks.length
  ) {
    throw new TypeError(
      "GitHub delivery requires a repository path, base, and non-empty unique requiredChecks",
    );
  }
  const remote = opts.remote ?? "origin";
  const prefix = opts.branchPrefix ?? "weft/";
  const maxPages = opts.maxPages ?? 100;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote) ||
    !prefix ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1000
  ) {
    throw new TypeError("invalid GitHub delivery remote, branchPrefix, or maxPages");
  }
  const adapter = opts.adapter ?? nativeAdapter(opts.token);
  const repository = `${opts.owner}/${opts.repo}`;
  const endpoint = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
  const resources = [`https://github.com/${repository}/pulls`];
  const unknown = (detail: string): ReconciledOperation => ({ status: "unknown", detail, resources });

  async function local(
    context: OperationContext,
  ): Promise<{ candidate: WorkspaceCandidate; remoteUrl: string }> {
    const candidate = context.candidate;
    if (
      !candidate ||
      candidate.runId !== context.runId ||
      opts.requiredChecks.some((check) => !context.checks?.includes(check))
    ) {
      throw new StepError(
        "check_failed",
        "GitHub delivery requires an owned candidate and the host's required check proofs",
      );
    }
    if (
      !candidate.branch.startsWith(prefix) ||
      candidate.branch === opts.base ||
      !/^[a-f0-9]{40,64}$/.test(candidate.head) ||
      !/^[a-f0-9]{40,64}$/.test(candidate.tree)
    ) {
      throw new StepError("invalid_input", "candidate is outside the configured GitHub branch namespace");
    }
    if ((await realpath(candidate.repository)) !== (await realpath(opts.repositoryPath))) {
      throw new StepError("invalid_input", "candidate belongs to a different local repository");
    }
    const git = (cwd: string, args: string[]) => adapter.git(cwd, args, context.signal);
    const [branch, head, tree, status, common, sourceCommon, urls] = await Promise.all([
      git(context.cwd, ["symbolic-ref", "--short", "HEAD"]),
      git(context.cwd, ["rev-parse", "HEAD"]),
      git(context.cwd, ["rev-parse", "HEAD^{tree}"]),
      git(context.cwd, ["status", "--porcelain", "--untracked-files=all"]),
      git(context.cwd, ["rev-parse", "--git-common-dir"]),
      git(opts.repositoryPath, ["rev-parse", "--git-common-dir"]),
      git(context.cwd, ["remote", "get-url", "--push", "--all", remote]),
    ]);
    if (
      branch.trim() !== candidate.branch ||
      head.trim() !== candidate.head ||
      tree.trim() !== candidate.tree ||
      status.trim()
    ) {
      throw new StepError("stale_candidate", "GitHub delivery candidate changed after verification");
    }
    if (
      (await realpath(resolve(context.cwd, common.trim()))) !==
      (await realpath(resolve(opts.repositoryPath, sourceCommon.trim())))
    ) {
      throw new StepError("invalid_input", "delivery worktree belongs to a different Git repository");
    }
    const pushUrls = urls.trim().split("\n");
    if (pushUrls.length !== 1 || !matchesRepository(pushUrls[0]!, repository)) {
      throw new StepError(
        "invalid_input",
        "push remote must point only to the host-configured GitHub repository without embedded credentials",
      );
    }
    await git(context.cwd, ["check-ref-format", `refs/heads/${candidate.branch}`]);
    await git(context.cwd, ["check-ref-format", `refs/heads/${opts.base}`]);
    return { candidate, remoteUrl: pushUrls[0]! };
  }

  async function request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    context: OperationContext,
    allowed = [200],
  ): Promise<unknown> {
    const response = await adapter.request(method, path, body, context.signal);
    if (!allowed.includes(response.status))
      throw new Error(`GitHub ${method} request failed with HTTP ${response.status}`);
    return response.status === 404 ? null : response.body;
  }

  async function remoteHead(
    candidate: WorkspaceCandidate,
    remoteUrl: string,
    context: OperationContext,
  ): Promise<string | null> {
    // Check base visibility before interpreting a head 404 as absence.
    await request("GET", `${endpoint}/git/ref/heads/${encodeURIComponent(opts.base)}`, undefined, context);
    const ref = await request(
      "GET",
      `${endpoint}/git/ref/heads/${encodeURIComponent(candidate.branch)}`,
      undefined,
      context,
      [200, 404],
    );
    const sha =
      ref === null
        ? null
        : z
            .object({
              ref: z.literal(`refs/heads/${candidate.branch}`),
              object: z.object({ sha: z.string() }),
            })
            .parse(ref).object.sha;
    const refs = (
      await adapter.git(
        context.cwd,
        ["ls-remote", "--heads", remoteUrl, `refs/heads/${candidate.branch}`],
        context.signal,
      )
    ).trim();
    const expected = sha === null ? "" : `${sha}\trefs/heads/${candidate.branch}`;
    if (refs !== expected) throw new Error("GitHub API and Git remote disagree about the candidate ref");
    return sha;
  }

  function identity(input: z.infer<typeof Input>, context: OperationContext, candidate: WorkspaceCandidate) {
    const requestHash = hash(JSON.stringify([context.runId, context.requestId]));
    const digest = hash(
      JSON.stringify([
        repository,
        opts.base,
        opts.draft ?? true,
        [...opts.requiredChecks].sort(),
        candidate.branch,
        candidate.head,
        candidate.tree,
        candidate.environment,
        input,
      ]),
    );
    return {
      marker: `<!-- weft-request:${requestHash}:${digest} -->`,
      digest,
      file: join(opts.repositoryPath, ".weft", "github-delivery", `${requestHash}.json`),
    };
  }

  async function inspect(
    raw: unknown,
    context: OperationContext,
  ): Promise<{
    outcome: ReconciledOperation;
    input: z.infer<typeof Input>;
    candidate: WorkspaceCandidate;
    remoteUrl: string;
    state: ReturnType<typeof identity>;
    head: string | null;
  }> {
    const input = Input.parse(raw);
    if (input.body.includes("<!-- weft-request:"))
      throw new StepError("invalid_input", "PR body must not contain a host request marker");
    const { candidate, remoteUrl } = await local(context);
    const state = identity(input, context, candidate);
    const phase = await readPhase(state.file);
    if (phase && phase.digest !== state.digest)
      throw new StepError(
        "invalid_input",
        "GitHub request was already used for a different candidate or payload",
      );
    const pulls: PullRequest[] = [];
    let complete = false;
    for (let page = 1; page <= maxPages; page++) {
      const body = await request(
        "GET",
        `${endpoint}/pulls?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
        undefined,
        context,
      );
      const batch = z.array(Pull).parse(body);
      pulls.push(...batch);
      if (batch.length < 100) {
        complete = true;
        break;
      }
    }
    const head = await remoteHead(candidate, remoteUrl, context);
    let outcome: ReconciledOperation;
    const marked = pulls.filter((pull) => pull.body?.includes(state.marker));
    const related = pulls.filter(
      (pull) =>
        pull.head.ref === candidate.branch &&
        pull.head.repo?.full_name.toLowerCase() === repository.toLowerCase(),
    );
    if (!complete)
      outcome = unknown("pull request history exceeded maxPages; absence and uniqueness are unproven");
    else if (marked.length > 1)
      outcome = unknown("multiple pull requests contain this durable request marker");
    else if (marked.length === 1) {
      const pull = marked[0]!;
      if (!matchesPull(pull, candidate, head))
        outcome = unknown(
          "recorded pull request is closed, moved, or no longer matches the verified candidate",
        );
      else outcome = { status: "applied", output: receipt(pull, candidate, context) };
    } else if (related.length)
      outcome = unknown("candidate branch already has a pull request without this request marker");
    else if (phase?.phase === "creating" || phase?.phase === "created")
      outcome = unknown(
        "a PR creation may have been sent; no matching receipt is visible, so creation will not be repeated",
      );
    else if (head !== null && head !== candidate.head)
      outcome = unknown("remote branch points to a different commit; it will not be overwritten");
    else outcome = { status: "not_applied" };
    return { outcome, input, candidate, remoteUrl, state, head };
  }

  function matchesPull(pull: PullRequest, candidate: WorkspaceCandidate, head: string | null): boolean {
    return (
      pull.state === "open" &&
      pull.head.sha === candidate.head &&
      head === candidate.head &&
      pull.head.ref === candidate.branch &&
      pull.head.repo?.full_name.toLowerCase() === repository.toLowerCase() &&
      pull.base.ref === opts.base &&
      pull.base.repo.full_name.toLowerCase() === repository.toLowerCase() &&
      pull.html_url === `https://github.com/${repository}/pull/${pull.number}`
    );
  }

  function receipt(
    pull: PullRequest,
    candidate: WorkspaceCandidate,
    context: OperationContext,
  ): GitHubReviewedPrReceipt {
    return {
      url: pull.html_url,
      number: pull.number,
      head: candidate.head,
      branch: candidate.branch,
      repository,
      base: opts.base,
      requestId: context.requestId,
      draft: pull.draft,
    };
  }

  return Object.freeze({
    risk: "high",
    delivery: true,
    requiredChecks: Object.freeze(opts.requiredChecks),
    async reconcile(input: unknown, context: OperationContext): Promise<ReconciledOperation> {
      return (await inspect(input, context)).outcome;
    },
    async execute(input: unknown, context: OperationContext): Promise<GitHubReviewedPrReceipt> {
      const inspected = await inspect(input, context);
      if (inspected.outcome.status === "applied") return inspected.outcome.output as GitHubReviewedPrReceipt;
      if (inspected.outcome.status === "unknown")
        throw new StepError("recovery_required", inspected.outcome.detail);
      const { candidate, state } = inspected;
      await savePhase(state.file, { digest: state.digest, phase: "pushing" });
      if (inspected.head === null) {
        await local(context);
        // Empty lease is create-only: even a racing branch creation cannot be overwritten.
        await adapter.git(
          context.cwd,
          [
            "push",
            "--porcelain",
            "--no-follow-tags",
            `--force-with-lease=refs/heads/${candidate.branch}:`,
            "--",
            inspected.remoteUrl,
            `${candidate.head}:refs/heads/${candidate.branch}`,
          ],
          context.signal,
        );
      }
      if ((await remoteHead(candidate, inspected.remoteUrl, context)) !== candidate.head)
        throw new StepError("recovery_required", "pushed candidate ref could not be verified");
      await local(context);
      await savePhase(state.file, { digest: state.digest, phase: "creating" });
      const pull = Pull.parse(
        await request(
          "POST",
          `${endpoint}/pulls`,
          {
            title: inspected.input.title,
            body: `${inspected.input.body}\n\n${state.marker}`,
            head: candidate.branch,
            base: opts.base,
            draft: opts.draft ?? true,
            maintainer_can_modify: false,
          },
          context,
          [201],
        ),
      );
      const head = await remoteHead(candidate, inspected.remoteUrl, context);
      if (!pull.body?.includes(state.marker) || !matchesPull(pull, candidate, head))
        throw new StepError(
          "recovery_required",
          "created PR response does not match the verified candidate and request",
        );
      await savePhase(state.file, { digest: state.digest, phase: "created" });
      return receipt(pull, candidate, context);
    },
  });
}

/** Read-only, exact-head remote feedback. A new operation key is needed for each observation. */
export function createGitHubPrFeedbackBinding(options: GitHubPrFeedbackOptions): OperationBinding {
  const opts = { ...options, requiredChecks: [...options.requiredChecks] };
  const requiredApprovals = opts.requiredApprovals ?? 1;
  const maxPages = opts.maxPages ?? 100;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(opts.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(opts.repo) ||
    [".", ".."].includes(opts.repo) ||
    !opts.requiredChecks.length ||
    opts.requiredChecks.some((name) => !name.trim()) ||
    new Set(opts.requiredChecks).size !== opts.requiredChecks.length ||
    !Number.isInteger(requiredApprovals) ||
    requiredApprovals < 0 ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 1000
  ) {
    throw new TypeError(
      "GitHub PR feedback requires a fixed repository, required check names, and valid approval/page limits",
    );
  }
  const adapter = opts.adapter ?? nativeAdapter(opts.token);
  const repository = `${opts.owner}/${opts.repo}`;
  const endpoint = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
  const FeedbackInput = z
    .object({ number: z.number().int().positive(), head: z.string().regex(/^[a-f0-9]{40,64}$/) })
    .strict();
  const Check = z.object({
    name: z.string(),
    head_sha: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
  });
  const Status = z.object({ context: z.string(), state: z.enum(["error", "failure", "pending", "success"]) });
  const Review = z.object({
    id: z.number(),
    user: z.object({ id: z.number() }).nullable(),
    state: z.string(),
    commit_id: z.string(),
    submitted_at: z.string().nullable(),
  });

  async function observe(raw: unknown, context: OperationContext): Promise<GitHubPrFeedback> {
    const input = FeedbackInput.parse(raw);
    const output: GitHubPrFeedback = {
      ...input,
      url: `https://github.com/${repository}/pull/${input.number}`,
      status: "unknown",
      draft: true,
      checks: Object.create(null),
      approvals: 0,
      requestedChanges: 0,
      detail: "Remote feedback is unavailable",
    };
    async function get(path: string): Promise<unknown> {
      const response = await adapter.request("GET", `${endpoint}${path}`, undefined, context.signal);
      if (response.status !== 200)
        throw new Error(`GitHub feedback request failed with HTTP ${response.status}`);
      return response.body;
    }
    async function pages<T>(path: string, parse: (body: unknown) => T[]): Promise<T[]> {
      const result: T[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const batch = parse(await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
        result.push(...batch);
        if (batch.length < 100) return result;
      }
      throw new Error("GitHub feedback history exceeded maxPages; results are incomplete");
    }
    const matches = (pull: PullRequest) =>
      pull.number === input.number &&
      pull.state === "open" &&
      pull.head.sha === input.head &&
      pull.head.repo?.full_name.toLowerCase() === repository.toLowerCase() &&
      pull.base.repo.full_name.toLowerCase() === repository.toLowerCase() &&
      pull.html_url === output.url;
    try {
      const pull = Pull.parse(await get(`/pulls/${input.number}`));
      output.draft = pull.draft;
      if (!matches(pull))
        return { ...output, detail: "Pull request is closed, moved, or points to a different candidate" };
      const result = await Promise.allSettled([
        pages(
          `/commits/${input.head}/check-runs?filter=latest`,
          (body) => z.object({ check_runs: z.array(Check) }).parse(body).check_runs,
        ),
        pages(`/commits/${input.head}/status`, (body) => {
          const combined = z.object({ sha: z.literal(input.head), statuses: z.array(Status) }).parse(body);
          return combined.statuses;
        }),
        pages(`/pulls/${input.number}/reviews`, (body) => z.array(Review).parse(body)),
      ]);
      for (const entry of result) if (entry.status === "rejected") throw entry.reason;
      const checks = (result[0] as PromiseFulfilledResult<z.infer<typeof Check>[]>).value;
      const statuses = (result[1] as PromiseFulfilledResult<z.infer<typeof Status>[]>).value;
      const reviews = (result[2] as PromiseFulfilledResult<z.infer<typeof Review>[]>).value;
      if (checks.some((check) => check.head_sha !== input.head))
        throw new Error("GitHub returned check evidence for a different candidate");
      for (const name of opts.requiredChecks) {
        const matches = [
          ...checks
            .filter((check) => check.name === name)
            .map((check) =>
              check.status !== "completed" ? "pending" : check.conclusion === "success" ? "passed" : "failed",
            ),
          ...statuses
            .filter((status) => status.context === name)
            .map((status) =>
              status.state === "success" ? "passed" : status.state === "pending" ? "pending" : "failed",
            ),
        ];
        output.checks[name] = matches.includes("failed")
          ? "failed"
          : !matches.length || matches.includes("pending")
            ? "pending"
            : "passed";
      }
      const decisions = new Map<number, z.infer<typeof Review>>();
      for (const review of reviews.sort(
        (a, b) =>
          (Date.parse(a.submitted_at ?? "") || 0) - (Date.parse(b.submitted_at ?? "") || 0) || a.id - b.id,
      )) {
        if (review.user && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
          decisions.set(review.user.id, review);
      }
      output.approvals = [...decisions.values()].filter(
        (review) => review.state === "APPROVED" && review.commit_id === input.head,
      ).length;
      output.requestedChanges = [...decisions.values()].filter(
        (review) => review.state === "CHANGES_REQUESTED",
      ).length;
      // Reject movement that happened while fetching independent CI/review endpoints.
      if (!matches(Pull.parse(await get(`/pulls/${input.number}`))))
        return {
          ...output,
          status: "unknown",
          detail: "Pull request moved while feedback was being collected",
        };
      output.status =
        output.requestedChanges || Object.values(output.checks).includes("failed")
          ? "failed"
          : output.approvals >= requiredApprovals &&
              Object.values(output.checks).every((status) => status === "passed")
            ? "passed"
            : "pending";
      output.detail =
        output.status === "passed"
          ? "Configured CI and current-head review requirements passed; draft/merge state is unchanged"
          : output.status === "failed"
            ? "A configured CI requirement failed or a reviewer requested changes"
            : "Waiting for configured CI results or current-head approvals";
      return output;
    } catch (error) {
      return {
        ...output,
        status: "unknown",
        detail: error instanceof Error ? error.message : "GitHub feedback could not be established",
      };
    }
  }
  return Object.freeze({
    risk: "low",
    execute: observe,
    reconcile: async (input: unknown, context: OperationContext) => ({
      status: "applied" as const,
      output: await observe(input, context),
    }),
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function matchesRepository(remote: string, repository: string): boolean {
  const ssh = /^git@github\.com:([^\s]+)$/.exec(remote);
  if (ssh) return ssh[1]!.replace(/\.git$/, "").toLowerCase() === repository.toLowerCase();
  try {
    const url = new URL(remote);
    return (
      (url.protocol === "https:" || url.protocol === "ssh:") &&
      url.hostname === "github.com" &&
      !url.port &&
      !url.search &&
      !url.hash &&
      !url.password &&
      (url.protocol === "https:" ? !url.username : url.username === "git") &&
      url.pathname
        .slice(1)
        .replace(/\.git$/, "")
        .toLowerCase() === repository.toLowerCase()
    );
  } catch {
    return false;
  }
}

async function readPhase(file: string): Promise<PhaseRecord | undefined> {
  try {
    return z
      .object({ digest: z.string(), phase: z.enum(["pushing", "creating", "created"]) })
      .strict()
      .parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function savePhase(file: string, state: PhaseRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const directory = await open(dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function nativeAdapter(token: GitHubReviewedPrOptions["token"]): GitHubDeliveryAdapter {
  if (!token)
    throw new TypeError("GitHub delivery requires an explicit host token source or trusted adapter");
  return {
    async git(cwd, args, signal) {
      try {
        const result = await exec("git", [...args], {
          cwd,
          signal,
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        return result.stdout;
      } catch {
        throw new Error(
          `GitHub delivery git ${args[0]} failed; inspect the retained workspace and remote ref`,
        );
      }
    },
    async request(method, path, body, signal) {
      const credential = typeof token === "function" ? await token() : token;
      if (!credential?.trim()) throw new Error("GitHub delivery host token is unavailable");
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${credential}`,
          "X-GitHub-Api-Version": "2026-03-10",
          "content-type": "application/json",
          "user-agent": "weft-host",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    },
  };
}
