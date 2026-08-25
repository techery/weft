import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "~/test/renderApp";

describe("queue", () => {
  it("lists what is blocked on you before what is running", async () => {
    renderApp("/queue");
    expect(await screen.findByRole("heading", { name: "Queue" })).toBeInTheDocument();
    expect(screen.getByText("3 waiting on you · 1 running")).toBeInTheDocument();
    expect(screen.getByText("Waiting on you · 3")).toBeInTheDocument();
    expect(screen.getByText("Running · 1")).toBeInTheDocument();
    expect(screen.getByText("Commit the staged fix")).toBeInTheDocument();
    expect(screen.getByText("classify — 2 of 4 agents still working")).toBeInTheDocument();
  });

  it("badges the nav with the number of runs waiting on you", async () => {
    renderApp("/queue");
    const queueLink = await screen.findByRole("link", { name: /Queue/ });
    expect(within(queueLink).getByText("3")).toBeInTheDocument();
  });

  it("opens a waiting run straight on its gate", async () => {
    const { user, router } = renderApp("/queue");
    const cards = await screen.findAllByRole("button", { name: "Answer →" });
    await user.click(cards[2]!);
    expect(router.state.location.pathname).toBe("/runs/r-045");
    expect(await screen.findByRole("heading", { name: "Commit the staged fix" })).toBeInTheDocument();
  });
});

describe("run detail", () => {
  it("shows the gate form for the step that is holding the run", async () => {
    renderApp("/runs/r-045?from=queue&tab=steps&step=gate-5");
    expect(
      await screen.findByRole("heading", { name: "gate: commit the fix · step 10" }),
    ).toBeInTheDocument();
    expect(screen.getByText("human.requested · gate-5")).toBeInTheDocument();
    expect(screen.getByText("risk: write")).toBeInTheDocument();
    expect(
      screen.getByText('{ action: "open a PR", notify: ["#eng-alerts"], wait: true, note: "" }'),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /open a PR/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Approve & resume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard & stop" })).toBeInTheDocument();
  });

  it("rewrites the payload as the answer changes", async () => {
    const { user } = renderApp("/runs/r-045?from=queue&tab=steps&step=gate-5");
    // The radio itself is visually hidden; the card is its label.
    await user.click(await screen.findByText("commit only"));
    await user.click(screen.getByRole("button", { name: "#on-call" }));
    expect(
      screen.getByText(
        '{ action: "commit only", notify: ["#eng-alerts", "#on-call"], wait: true, note: "" }',
      ),
    ).toBeInTheDocument();
  });

  it("resumes the run when the gate is approved", async () => {
    const { user } = renderApp("/runs/r-045?from=queue&tab=steps&step=gate-5");
    await user.click(await screen.findByRole("button", { name: "Approve & resume" }));
    expect(await screen.findByText("4 steps active")).toBeInTheDocument();
    expect(screen.getByText("next → step 11 · push branch, started at 08:42")).toBeInTheDocument();
    expect(screen.getByText('{ answer: "open a PR", answered_by: "you", at: "08:42" }')).toBeInTheDocument();
  });

  it("stops the run when the gate is denied", async () => {
    const { user } = renderApp("/runs/r-045?from=queue&tab=steps&step=gate-5");
    await user.click(await screen.findByRole("button", { name: "Discard & stop" }));
    expect(await screen.findByText("stopped by you")).toBeInTheDocument();
    expect(
      screen.getByText("run.stopped — the branch was left in place and no further steps were opened."),
    ).toBeInTheDocument();
  });

  it("moves between tabs and keeps them in the URL", async () => {
    const { user, router } = renderApp("/runs/r-045?from=runs&tab=steps&step=verify-1");
    await user.click(await screen.findByRole("tab", { name: /Findings/ }));
    expect(router.state.location.search).toMatchObject({ tab: "findings" });
    expect(screen.getByText("Lockfile still pins the vulnerable transitive dep")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Journal/ }));
    expect(screen.getByText("verify failed · exit 1 · 2 findings recorded")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Changes/ }));
    expect(screen.getByText("@@ -12,4 +12,9 @@ fetchWithRetry()")).toBeInTheDocument();
    // The branch note is repeated under the tree and under the diff.
    expect(screen.getAllByText("branch weft/r-045 · not pushed")).toHaveLength(2);

    await user.click(screen.getByRole("tab", { name: /Artifacts/ }));
    expect(screen.getByText("Dependency audit — 3 advisories")).toBeInTheDocument();
  });

  it("opens the step a finding created", async () => {
    const { user } = renderApp("/runs/r-045?from=runs&tab=findings");
    await user.click((await screen.findAllByRole("button", { name: "Open step" }))[1]!);
    expect(await screen.findByRole("heading", { name: "patch call site · step 9" })).toBeInTheDocument();
    expect(screen.getByText('grep "retryGuard" src/**')).toBeInTheDocument();
  });

  it("selects a different changed file", async () => {
    const { user } = renderApp("/runs/r-045?from=runs&tab=changes");
    await user.click(await screen.findByRole("button", { name: /package-lock\.json/ }));
    expect(screen.getByText("@@ -1204,7 +1204,7 @@ node_modules/undici")).toBeInTheDocument();
  });

  it("goes back to wherever the run was opened from", async () => {
    const { user, router } = renderApp("/runs/r-049?from=runs&tab=steps");
    await user.click(await screen.findByRole("button", { name: "← Runs" }));
    expect(router.state.location.pathname).toBe("/runs");
  });

  it("jumps to the workflow that defines the run", async () => {
    const { user, router } = renderApp("/runs/r-045?from=queue&tab=steps&step=verify-1");
    await user.click(await screen.findByRole("button", { name: "deps-audit.ts" }));
    expect(router.state.location.pathname).toBe("/workflows");
    expect(router.state.location.search).toMatchObject({ wf: "deps-audit.ts" });
  });
});

describe("runs", () => {
  it("filters the journal index", async () => {
    const { user } = renderApp("/runs");
    expect(await screen.findByText("5 runs in the journal window · 30d")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finished" }));
    expect(screen.getByText("v0.8.4 released")).toBeInTheDocument();
    expect(screen.queryByText("gate: pick a hero")).not.toBeInTheDocument();
  });
});

describe("workflows", () => {
  it("inspects the selected workflow", async () => {
    const { user } = renderApp("/workflows");
    expect(await screen.findByText(".weft/workflows/deps-audit.ts")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Issue triage/ }));
    expect(screen.getByText(".weft/workflows/triage.ts")).toBeInTheDocument();
    expect(screen.getByText("1 failed · rate limit at classify")).toBeInTheDocument();
    expect(screen.getByText("on issue open")).toBeInTheDocument();
  });

  it("opens a recent run from the inspector", async () => {
    const { user, router } = renderApp("/workflows?wf=triage.ts");
    await user.click(await screen.findByRole("button", { name: /r-049/ }));
    expect(router.state.location.pathname).toBe("/runs/r-049");
  });
});

describe("settings", () => {
  it("changes the approval policy and the pool size", async () => {
    const { user } = renderApp("/settings");
    const writeRow = (await screen.findByText("fs.write · labels · branch push")).parentElement!;
    await user.click(within(writeRow).getByRole("button", { name: "auto" }));
    expect(within(writeRow).getByRole("button", { name: "auto" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("pool 8 agents")).toBeInTheDocument();
  });

  it("edits the default budget and reflects it in the status bar", async () => {
    const { user } = renderApp("/settings");
    const budget = await screen.findByDisplayValue("$8.00");
    await user.clear(budget);
    await user.type(budget, "$12.00");
    expect(screen.getByText("default budget $12.00")).toBeInTheDocument();
  });
});

describe("launcher", () => {
  it("opens on ⌘K, filters, and starts a workflow with no live run", async () => {
    const { user, router } = renderApp("/queue");
    await screen.findByRole("heading", { name: "Queue" });
    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "Run a workflow" });
    await user.type(within(dialog).getByLabelText("Filter workflows"), "digest");
    expect(within(dialog).getByText("1 of 6 match")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(await within(dialog).findByText(/step 2 of 2/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Start run ⏎" }));
    expect(router.state.location.pathname).toBe("/runs");
    expect(await screen.findByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText("queued just now · the daemon opens step 1 in a moment")).toBeInTheDocument();
  });

  it("jumps to the live run when the workflow already has one", async () => {
    const { user, router } = renderApp("/queue");
    await user.click(await screen.findByRole("button", { name: "Issue triage" }));
    const dialog = await screen.findByRole("dialog", { name: "Run a workflow" });
    await user.click(within(dialog).getByRole("button", { name: "Start run ⏎" }));
    expect(router.state.location.pathname).toBe("/runs/r-049");
  });

  it("closes on escape", async () => {
    const { user } = renderApp("/queue");
    await screen.findByRole("heading", { name: "Queue" });
    await user.keyboard("{Meta>}k{/Meta}");
    await screen.findByRole("dialog", { name: "Run a workflow" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
