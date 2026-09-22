import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationContext } from "@techery/weft-core";
import { defineOperation, defineWorkflow, type WorkspaceCandidate, z } from "@techery/weft-sdk";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGitHubPrFeedbackBinding,
  createGitHubReviewedPrBinding,
  createWeft,
  GITHUB_REVIEWED_PR_BINDING,
  type GitHubDeliveryAdapter,
  type GitHubReviewedPrOptions,
} from "../src/index.ts";
import { cleanupRoots, tempRoot } from "./helpers.ts";

afterAll(cleanupRoots);
const head = "a".repeat(40);
const tree = "b".repeat(40);
const branch = "weft/fix-42";
const input = { title: "Fix the regression", body: "Verified the candidate against unit tests and review." };

async function feedbackFixture() {
  const fixtureValue = await fixture();
  await fixtureValue.binding.execute(input, fixtureValue.context);
  const feedback = createGitHubPrFeedbackBinding({
    owner: "example",
    repo: "project",
    requiredChecks: ["tests", "lint"],
    adapter: fixtureValue.options.adapter,
  });
  const { state } = fixtureValue;
  state.checks = [{ name: "tests", head_sha: head, status: "completed", conclusion: "success" }];
  state.statuses = [{ context: "lint", state: "success" }];
  state.reviews = [
    { id: 1, user: { id: 7 }, state: "APPROVED", commit_id: head, submitted_at: "2026-09-04T12:00:00Z" },
  ];
  return { ...fixtureValue, feedback };
}

interface TestPull {
  number: number;
  html_url: string;
  body: string;
  state: "open" | "closed";
  draft: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
}

async function fixture() {
  const root = await tempRoot();
  await mkdir(join(root, ".git"));
  const state = {
    branch,
    head,
    tree,
    status: "",
    remote: null as string | null,
    remoteUrl: "git@github.com:example/project.git",
    pulls: [] as TestPull[],
    pushFailure: false,
    postFailure: false,
    lostResponse: false,
    listFailure: false,
    pushed: [] as string[][],
    posts: [] as Record<string, unknown>[],
    paths: [] as string[],
    checks: [] as Array<{ name: string; head_sha: string; status: string; conclusion: string | null }>,
    statuses: [] as Array<{ context: string; state: string }>,
    reviews: [] as Array<{
      id: number;
      user: { id: number };
      state: string;
      commit_id: string;
      submitted_at: string;
    }>,
    moveWhilePolling: false,
  };
  const adapter: GitHubDeliveryAdapter = {
    async git(_cwd, args) {
      if (args[0] === "symbolic-ref") return state.branch;
      if (args[0] === "status") return state.status;
      if (args[0] === "rev-parse")
        return args[1] === "HEAD" ? state.head : args[1] === "HEAD^{tree}" ? state.tree : ".git";
      if (args[0] === "remote") return state.remoteUrl;
      if (args[0] === "check-ref-format") return "";
      if (args[0] === "ls-remote") return state.remote ? `${state.remote}\trefs/heads/${branch}` : "";
      if (args[0] === "push") {
        state.pushed.push([...args]);
        state.remote = head;
        if (state.pushFailure) throw new Error("push response lost");
        return "ok";
      }
      throw new Error(`unexpected git call ${args.join(" ")}`);
    },
    async request(method, path, raw) {
      state.paths.push(path);
      if (method === "GET" && state.listFailure) return { status: 403, body: {} };
      if (method === "GET" && /\/pulls\/\d+$/.test(path)) return { status: 200, body: state.pulls[0] };
      if (method === "GET" && path.includes("/check-runs?")) {
        if (state.moveWhilePolling) state.pulls[0]!.head.sha = "d".repeat(40);
        return { status: 200, body: { check_runs: state.checks } };
      }
      if (method === "GET" && path.includes("/status?"))
        return { status: 200, body: { sha: head, statuses: state.statuses } };
      if (method === "GET" && path.includes("/reviews?")) return { status: 200, body: state.reviews };
      if (method === "GET" && path.includes("/pulls?")) {
        if (state.listFailure) return { status: 403, body: {} };
        const page = Number(new URL(`https://api.github.com${path}`).searchParams.get("page"));
        return { status: 200, body: state.pulls.slice((page - 1) * 100, page * 100) };
      }
      if (method === "GET" && path.includes("/git/ref/heads/main"))
        return { status: 200, body: { ref: "refs/heads/main", object: { sha: "c".repeat(40) } } };
      if (method === "GET" && path.includes("/git/ref/heads/"))
        return state.remote
          ? { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: state.remote } } }
          : { status: 404, body: {} };
      if (method === "POST") {
        const body = raw as Record<string, unknown>;
        state.posts.push(body);
        if (state.postFailure) throw new Error("POST outcome unknown");
        const pull: TestPull = {
          number: state.pulls.length + 1,
          html_url: `https://github.com/example/project/pull/${state.pulls.length + 1}`,
          body: String(body.body),
          state: "open",
          draft: body.draft === true,
          head: { ref: String(body.head), sha: state.remote!, repo: { full_name: "example/project" } },
          base: { ref: String(body.base), repo: { full_name: "example/project" } },
        };
        state.pulls.push(pull);
        if (state.lostResponse) throw new Error("POST response lost after creation");
        return { status: 201, body: pull };
      }
      throw new Error(`unexpected API call ${method} ${path}`);
    },
  };
  const options: GitHubReviewedPrOptions = {
    repositoryPath: root,
    owner: "example",
    repo: "project",
    base: "main",
    requiredChecks: ["unit", "review"],
    adapter,
  };
  const context: OperationContext = {
    runId: "run-1",
    requestId: "run-1:deliver",
    cwd: root,
    signal: new AbortController().signal,
    checks: ["unit", "review"],
    candidate: {
      id: "candidate-1",
      runId: "run-1",
      workspaceId: "workspace-1",
      repository: root,
      branch,
      head,
      tree,
      generation: 1,
      environment: "fixture-environment",
    } as WorkspaceCandidate,
  };
  return { root, state, options, context, binding: createGitHubReviewedPrBinding(options) };
}

describe("opt-in GitHub reviewed PR host binding", () => {
  it("pushes only the exact candidate to a new ref, verifies it, and creates a marked draft PR", async () => {
    const { state, binding, context } = await fixture();
    expect(binding).toMatchObject({ risk: "high", delivery: true, requiredChecks: ["unit", "review"] });
    const receipt = await binding.execute(input, context);
    expect(receipt).toMatchObject({
      url: "https://github.com/example/project/pull/1",
      head,
      branch,
      draft: true,
      base: "main",
    });
    expect(state.pushed).toHaveLength(1);
    expect(state.pushed[0]).toContain(`--force-with-lease=refs/heads/${branch}:`);
    expect(state.pushed[0]).not.toContain("--no-verify");
    expect(state.pushed[0]?.at(-1)).toBe(`${head}:refs/heads/${branch}`);
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]).toMatchObject({
      head: branch,
      base: "main",
      draft: true,
      maintainer_can_modify: false,
    });
    expect(state.posts[0]?.body).toMatch(/<!-- weft-request:[a-f0-9]{64}:[a-f0-9]{64} -->/);
    expect(state.paths.some((path) => path.includes("state=all"))).toBe(true);
  });

  it.each(["branch", "head", "tree", "status"] as const)(
    "rejects changed local %s before publication",
    async (field) => {
      const { binding, state, context } = await fixture();
      state[field] = "changed";
      await expect(binding.execute(input, context)).rejects.toThrow(/candidate changed/);
      expect(state.pushed).toEqual([]);
      expect(state.posts).toEqual([]);
    },
  );

  it.each([
    "https://evil.invalid/example/project.git",
    "git@github.com:other/project.git",
    "https://secret@github.com/example/project.git",
    "git@github.com:example/project.git\ngit@github.com:other/project.git",
  ])("rejects an unapproved or credential-bearing push target", async (remoteUrl) => {
    const { binding, state, context } = await fixture();
    state.remoteUrl = remoteUrl;
    await expect(binding.execute(input, context)).rejects.toThrow(/push remote/);
    expect(state.pushed).toEqual([]);
  });

  it("requires host check names and delivery context", async () => {
    const { binding, state, context } = await fixture();
    await expect(binding.execute(input, { ...context, checks: ["unit"] })).rejects.toThrow(
      /required check proofs/,
    );
    await expect(binding.execute(input, { ...context, candidate: undefined })).rejects.toThrow(
      /owned candidate/,
    );
    expect(state.posts).toEqual([]);
  });

  it("recovers a lost push response and never pushes an existing remote ref twice", async () => {
    const { options, state, binding, context } = await fixture();
    state.pushFailure = true;
    await expect(binding.execute(input, context)).rejects.toThrow(/push response lost/);
    const restarted = createGitHubReviewedPrBinding(options);
    expect(await restarted.reconcile(input, context)).toEqual({ status: "not_applied" });
    state.pushFailure = false;
    await restarted.execute(input, context);
    expect(state.pushed).toHaveLength(1);
    expect(state.posts).toHaveLength(1);
  });

  it("reconciles a created PR after losing its response, including after restarting the binding", async () => {
    const { options, state, binding, context } = await fixture();
    state.lostResponse = true;
    await expect(binding.execute(input, context)).rejects.toThrow(/response lost/);
    const restarted = createGitHubReviewedPrBinding(options);
    expect(await restarted.reconcile(input, context)).toMatchObject({
      status: "applied",
      output: { number: 1, head },
    });
    await restarted.execute(input, context);
    expect(state.posts).toHaveLength(1);
  });

  it("does not retry an uncertain PR creation just because no PR is visible", async () => {
    const { options, state, binding, context } = await fixture();
    state.postFailure = true;
    await expect(binding.execute(input, context)).rejects.toThrow(/outcome unknown/);
    const restarted = createGitHubReviewedPrBinding(options);
    expect(await restarted.reconcile(input, context)).toMatchObject({
      status: "unknown",
      detail: expect.stringContaining("will not be repeated"),
    });
    await expect(restarted.execute(input, context)).rejects.toThrow(/will not be repeated/);
    expect(state.posts).toHaveLength(1);
  });

  it.each(["closed", "moved", "marker removed", "duplicate", "remote changed"])(
    "retains uncertain state for %s PRs without creating a replacement",
    async (change) => {
      const { state, binding, context } = await fixture();
      await binding.execute(input, context);
      if (change === "closed") state.pulls[0]!.state = "closed";
      if (change === "moved") state.pulls[0]!.head.ref = "renamed-branch";
      if (change === "marker removed") state.pulls[0]!.body = "edited";
      if (change === "duplicate") state.pulls.push({ ...state.pulls[0]!, number: 2 });
      if (change === "remote changed") state.remote = "d".repeat(40);
      expect(await binding.reconcile(input, context)).toMatchObject({ status: "unknown" });
      await expect(binding.execute(input, context)).rejects.toThrow();
      expect(state.posts).toHaveLength(1);
    },
  );

  it("refuses request reuse for changed code or payload", async () => {
    const { state, binding, context } = await fixture();
    await binding.execute(input, context);
    await expect(binding.reconcile({ ...input, title: "Changed" }, context)).rejects.toThrow(
      /different candidate or payload/,
    );
    state.head = "d".repeat(40);
    await expect(
      binding.reconcile(input, { ...context, candidate: { ...context.candidate!, head: state.head } }),
    ).rejects.toThrow(/different candidate or payload/);
    expect(state.posts).toHaveLength(1);
  });

  it("does not equate unavailable or truncated history with absence", async () => {
    const { state, binding, options, context } = await fixture();
    state.listFailure = true;
    await expect(binding.execute(input, context)).rejects.toThrow(/HTTP 403/);
    state.listFailure = false;
    await binding.execute(input, context);
    const reference = state.pulls[0]!;
    state.pulls = Array.from({ length: 100 }, (_, index) => ({
      ...reference,
      number: index + 1,
      body: "unrelated",
    }));
    const limited = createGitHubReviewedPrBinding({ ...options, maxPages: 1 });
    expect(await limited.reconcile(input, context)).toMatchObject({
      status: "unknown",
      detail: expect.stringContaining("maxPages"),
    });
    expect(state.posts).toHaveLength(1);
  });

  it("registers only explicitly configured trusted operations in the assembled host", async () => {
    const root = await tempRoot();
    const operation = defineOperation({
      name: "test-effect",
      revision: "v1",
      binding: "test.effect",
      risk: "low",
      input: z.object({ value: z.string() }),
      output: z.string(),
    });
    const workflow = defineWorkflow(
      {
        id: "host-operations",
        description: "host operation injection",
        input: z.object({}),
        output: z.string(),
      },
      async (ctx) => (await ctx.operation(operation, { value: "ok" }, { key: "effect" })).value,
    );
    const disabled = await createWeft({ cwd: root, providers: "mock" });
    try {
      const run = await disabled.engine.start(workflow, { input: {}, cwd: root });
      await expect(run.result).rejects.toThrow(/no host operation binding/);
    } finally {
      await disabled.close();
    }
    const enabled = await createWeft({
      cwd: root,
      providers: "mock",
      operations: {
        "test.effect": {
          risk: "low",
          execute: async (raw) => (raw as { value: string }).value,
          reconcile: async () => ({ status: "not_applied" }),
        },
      },
    });
    try {
      const run = await enabled.engine.start(workflow, { input: {}, cwd: root });
      expect(await run.result).toBe("ok");
      expect(await readFile(join(root, ".weft", ".gitignore"), "utf8")).toContain("runs/");
    } finally {
      await enabled.close();
    }
  });

  it("requires explicit GitHub credentials and rejects duplicate binding configuration", async () => {
    const { root, options } = await fixture();
    expect(() => createGitHubReviewedPrBinding({ ...options, adapter: undefined })).toThrow(
      /explicit host token/,
    );
    const { repositoryPath: _repositoryPath, ...githubReviewedPr } = options;
    await expect(
      createWeft({
        cwd: root,
        providers: "mock",
        githubReviewedPr,
        operations: { [GITHUB_REVIEWED_PR_BINDING]: createGitHubReviewedPrBinding(options) },
      }),
    ).rejects.toThrow(/configured twice/);
  });
});

describe("read-only GitHub PR feedback", () => {
  it.each(["missing", "failed", "passed"] as const)(
    "keeps a prototype-named required check visible when its evidence is %s",
    async (evidence) => {
      const { options, context, state } = await feedbackFixture();
      const feedback = createGitHubPrFeedbackBinding({
        owner: "example",
        repo: "project",
        requiredChecks: ["__proto__"],
        adapter: options.adapter,
      });
      state.checks =
        evidence === "missing"
          ? []
          : [
              {
                name: "__proto__",
                head_sha: head,
                status: "completed",
                conclusion: evidence === "passed" ? "success" : "failure",
              },
            ];
      const result = (await feedback.execute({ number: 1, head }, context)) as {
        status: string;
        checks: Record<string, string>;
      };
      const expected = evidence === "missing" ? "pending" : evidence;
      expect(result.status).toBe(expected);
      expect(Object.keys(result.checks)).toEqual(["__proto__"]);
      expect(Object.getOwnPropertyDescriptor(result.checks, "__proto__")?.value).toBe(expected);
      expect(
        Object.getOwnPropertyDescriptor(JSON.parse(JSON.stringify(result)).checks, "__proto__")?.value,
      ).toBe(expected);
    },
  );

  it("combines exact-head check runs, commit statuses, and current-head approvals", async () => {
    const { feedback, context, state } = await feedbackFixture();
    expect(await feedback.execute({ number: 1, head }, context)).toMatchObject({
      status: "passed",
      head,
      draft: true,
      checks: { tests: "passed", lint: "passed" },
      approvals: 1,
      requestedChanges: 0,
    });
    expect(state.pushed).toHaveLength(1);
    expect(state.posts).toHaveLength(1);
  });

  it("keeps absent checks and approvals from older commits pending", async () => {
    const { feedback, context, state } = await feedbackFixture();
    state.checks = [];
    state.reviews[0]!.commit_id = "c".repeat(40);
    expect(await feedback.execute({ number: 1, head }, context)).toMatchObject({
      status: "pending",
      approvals: 0,
      checks: { tests: "pending" },
    });
  });

  it("reports terminal failed or skipped checks and outstanding changes requested", async () => {
    const { feedback, context, state } = await feedbackFixture();
    state.checks[0]!.conclusion = "skipped";
    expect(await feedback.execute({ number: 1, head }, context)).toMatchObject({
      status: "failed",
      checks: { tests: "failed" },
    });
    state.checks[0]!.conclusion = "success";
    state.reviews.push({
      id: 2,
      user: { id: 7 },
      state: "CHANGES_REQUESTED",
      commit_id: head,
      submitted_at: "2026-09-04T13:00:00Z",
    });
    expect(await feedback.execute({ number: 1, head }, context)).toMatchObject({
      status: "failed",
      approvals: 0,
      requestedChanges: 1,
    });
    state.reviews.push({
      id: 3,
      user: { id: 7 },
      state: "APPROVED",
      commit_id: head,
      submitted_at: "2026-09-04T14:00:00Z",
    });
    expect(await feedback.execute({ number: 1, head }, context)).toMatchObject({
      status: "passed",
      approvals: 1,
      requestedChanges: 0,
    });
  });

  it.each(["closed", "changed head", "moves while polling", "unreadable", "wrong check head"])(
    "reports %s feedback as unknown",
    async (change) => {
      const { feedback, context, state } = await feedbackFixture();
      if (change === "closed") state.pulls[0]!.state = "closed";
      if (change === "changed head") state.pulls[0]!.head.sha = "d".repeat(40);
      if (change === "moves while polling") state.moveWhilePolling = true;
      if (change === "unreadable") state.listFailure = true;
      if (change === "wrong check head") state.checks[0]!.head_sha = "d".repeat(40);
      expect(await feedback.execute({ number: 1, head }, context)).toMatchObject({ status: "unknown" });
      expect(state.posts).toHaveLength(1);
    },
  );
});
