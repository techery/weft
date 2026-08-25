import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDaemon, fakeDaemon } from "~/test/daemon";
import { renderApp } from "~/test/renderApp";

let daemon: FakeDaemon;

beforeEach(() => {
  daemon = fakeDaemon();
});

afterEach(() => {
  daemon.restore();
});

describe("the queue", () => {
  it("shows the question a run is blocked on, from the daemon", async () => {
    renderApp("/queue");
    expect(await screen.findByText("Approve the v0.9.0 release")).toBeInTheDocument();
    expect(
      screen.getByText("Publishing creates a public GitHub release — weft cannot undo it."),
    ).toBeInTheDocument();
    expect(screen.getByText(/risk: high/)).toBeInTheDocument();
  });

  it("separates what is working from what is blocked", async () => {
    renderApp("/queue");
    await screen.findByText("Approve the v0.9.0 release");
    expect(screen.getByText(/Waiting on you · 1/)).toBeInTheDocument();
    expect(screen.getByText(/Running · 1/)).toBeInTheDocument();
  });

  it("opens the blocked run straight on its question", async () => {
    const { user, router } = renderApp("/queue");
    await user.click(await screen.findByRole("button", { name: /Answer/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/runs/r-waiting"));
    // The question that raised the gate, not the step's seq.
    expect(router.state.location.search).toMatchObject({ step: "gate:h1" });
  });

  it("says so when the daemon cannot be reached", async () => {
    daemon.fail("/api/pending", 500, "EACCES: permission denied, open journal.jsonl");
    renderApp("/queue");
    expect(await screen.findByText(/EACCES: permission denied/)).toBeInTheDocument();
  });
});

describe("the runs table", () => {
  it("lists every run with what it spent", async () => {
    renderApp("/runs");
    expect(await screen.findByText("r-waiting")).toBeInTheDocument();
    expect(screen.getByText("$0.71")).toBeInTheDocument();
    expect(screen.getByText("$0.09")).toBeInTheDocument();
    // A waiting run says what it is waiting for.
    expect(screen.getByText("Approve the v0.9.0 release")).toBeInTheDocument();
    expect(screen.getByText("2 steps active")).toBeInTheDocument();
  });
});

describe("a run", () => {
  it("shows its steps grouped by phase, with the gate marked as waiting", async () => {
    renderApp("/runs/r-waiting?from=runs&tab=steps");
    const rail = await screen.findByRole("navigation", { name: "Run steps" });
    expect(within(rail).getByText("draft release notes")).toBeInTheDocument();
    expect(within(rail).getByText("Draft")).toBeInTheDocument();
    expect(within(rail).getByText("Review")).toBeInTheDocument();
    // The human step is holding a question, which its own status cannot say.
    expect(within(rail).getByText("waiting on you")).toBeInTheDocument();
  });

  it("shows spend against the ceiling the run was actually given", async () => {
    renderApp("/runs/r-waiting?from=runs");
    expect(await screen.findByText(/\$0\.71 \/ \$4\.00/)).toBeInTheDocument();
  });

  it("shows a step's input, which only ?detail=1 carries", async () => {
    renderApp("/runs/r-waiting?from=runs&tab=steps&step=step:1");
    expect(await screen.findByText("draft release notes · step 1")).toBeInTheDocument();
    expect(screen.getByText("Since")).toBeInTheDocument();
    expect(screen.getByText("v0.8.4")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Step overview" })).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: "Data view" })).toHaveLength(2);
    expect(daemon.calls.some((call) => call.path === "/api/runs/r-waiting?detail=1")).toBe(true);
  });

  it("loads a recorded coding-session transcript inside its agent step", async () => {
    const { user } = renderApp("/runs/r-waiting?from=runs&tab=steps&step=step:1");
    const views = await screen.findByRole("tablist", { name: "Step views" });
    expect(screen.queryByRole("region", { name: "Agent log" })).not.toBeInTheDocument();
    await user.click(within(views).getByRole("tab", { name: "Agent log" }));
    const agentLog = await screen.findByRole("region", { name: "Agent log" });
    expect(within(agentLog).queryByRole("button", { name: /coding session/i })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Agent transcript" })).toBeInTheDocument();
    expect(screen.getByText("exit 0")).toBeInTheDocument();
    expect(await screen.findByText("git log --oneline v0.8.4..HEAD")).toBeInTheDocument();
    expect(screen.getByText("Drafted six release-note sections.")).toBeInTheDocument();
    expect(within(views).getByRole("tab", { name: "Agent log" })).toHaveAttribute("aria-selected", "true");
    expect(daemon.calls.some((call) => call.path.endsWith("?as=text"))).toBe(true);
  });

  it("builds the gate's form from the schema the workflow declared", async () => {
    renderApp("/runs/r-waiting?from=queue&tab=steps&step=gate:h1");
    expect(await screen.findByRole("heading", { name: "Approve the v0.9.0 release" })).toBeInTheDocument();
    // `approve` declares { approved, note }. The verdict is the two buttons, so the
    // schema's own boolean is not offered a third time as a toggle.
    expect(screen.getByLabelText("note")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Deny/ })).toBeInTheDocument();
  });

  it("answers the question and the run moves on", async () => {
    const { user } = renderApp("/runs/r-waiting?from=queue&tab=steps&step=gate:h1");
    await user.click(await screen.findByRole("button", { name: /Approve/ }));

    const answered = await waitFor(() => {
      const call = daemon.calls.find((c) => c.method === "POST" && c.path === "/api/runs/r-waiting/answer");
      expect(call).toBeDefined();
      return call!;
    });
    expect(answered.body).toMatchObject({ requestId: "h1", answer: { approved: true } });
    // The daemon drops the question, and the screen follows.
    await waitFor(() => expect(screen.queryByLabelText("note")).not.toBeInTheDocument());
  });

  it("renders the captured patch, split into files", async () => {
    renderApp("/runs/r-waiting?from=runs&tab=changes");
    // Named twice on purpose: once in the tree, once over the hunks.
    expect(await screen.findAllByText("CHANGELOG.md")).toHaveLength(2);
    // The count appears on the tree row and again over the hunks.
    expect(screen.getAllByText("+2")).toHaveLength(2);
    expect(screen.getByText("@@ -1,2 +1,4 @@")).toBeInTheDocument();
    expect(screen.getByText("+## v0.9.0")).toBeInTheDocument();
  });

  it("fetches an artifact's bytes only for the file being looked at", async () => {
    renderApp("/runs/r-waiting?from=runs&tab=artifacts");
    expect(await screen.findByText(/# Changelog/)).toBeInTheDocument();
    expect(daemon.calls.some((call) => call.path.startsWith("/api/blobs/aaaa"))).toBe(true);
  });

  it("hides a tab the run produced nothing for", async () => {
    renderApp("/runs/r-live?from=runs&tab=steps");
    await screen.findAllByText("classify #815");
    expect(screen.queryByRole("tab", { name: /Changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Notes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Journal/ })).not.toBeInTheDocument();
  });

  it("cancels a live run", async () => {
    const { user } = renderApp("/runs/r-live?from=runs");
    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    await waitFor(() =>
      expect(daemon.calls.some((c) => c.method === "POST" && c.path === "/api/runs/r-live/cancel")).toBe(
        true,
      ),
    );
  });

  it("says plainly when a run is not in the journal", async () => {
    renderApp("/runs/r-nope?from=runs");
    expect(await screen.findByText(/run r-nope not found/)).toBeInTheDocument();
  });
});

describe("workflows", () => {
  it("lists the registry and inspects the selected one", async () => {
    const { user } = renderApp("/workflows?wf=release");
    expect(await screen.findByText("Draft and publish release notes")).toBeInTheDocument();
    // The API returns a repo-relative path; the inspector must not prefix it again.
    expect(screen.getAllByText(".weft/workflows/release.ts").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\.weft\/workflows\/\.weft/)).not.toBeInTheDocument();
    expect(await screen.findByText("Verify release notes")).toBeInTheDocument();
    expect(screen.getByText("Every note links to source evidence")).toBeInTheDocument();
    expect(screen.getByText(/Two commits still need issue links/)).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "release" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tasks · 1" })).toBeInTheDocument();
    expect(screen.getByLabelText("Every note links to source evidence: met")).toBeInTheDocument();
    await user.click(screen.getByText(/2 notes · latest by draft-agent/));
    expect(screen.getByText(/Initial source scan completed/)).toBeInTheDocument();
  });
});

describe("settings", () => {
  it("shows the engine's real approval tiers, not the design's invented ones", async () => {
    renderApp("/settings");
    await screen.findByText(/Approval policy/i);
    for (const tier of ["low", "medium", "high", "irreversible"]) {
      expect(screen.getByText(tier)).toBeInTheDocument();
    }
    expect(screen.queryByText("destructive")).not.toBeInTheDocument();
  });
});

describe("the launcher", () => {
  it("starts a run from the workflow's declared inputs", async () => {
    const { user, router } = renderApp("/queue");
    await screen.findByText("Approve the v0.9.0 release");
    await user.keyboard("{Meta>}k{/Meta}");

    const dialog = await screen.findByRole("dialog", { name: "Run a workflow" });
    await user.click(within(dialog).getByText("triage"));
    const inputPane = within(dialog).getByRole("region", { name: "Workflow input" });
    expect(within(inputPane).getByText("schema-driven")).toBeInTheDocument();
    expect(within(inputPane).getByText("string · optional")).toBeInTheDocument();
    // `triage` declares window as an enum, so the form offers its values as pills.
    expect(await within(dialog).findByRole("button", { name: "24h" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "24h" }));
    await user.click(within(dialog).getByRole("button", { name: /Start run/ }));

    const started = await waitFor(() => {
      const call = daemon.calls.find((c) => c.method === "POST" && c.path === "/api/runs");
      expect(call).toBeDefined();
      return call!;
    });
    expect(started.body).toMatchObject({ workflow: "triage", input: { window: "24h" } });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/runs\//));
  });

  it("keeps the daemon's own refusal on screen instead of closing", async () => {
    daemon.fail("/api/runs", 400, 'triage has no input field "whoo" — it takes --window');
    const { user } = renderApp("/queue");
    await screen.findByText("Approve the v0.9.0 release");
    await user.keyboard("{Meta>}k{/Meta}");
    const dialog = await screen.findByRole("dialog", { name: "Run a workflow" });
    await user.click(within(dialog).getByText("triage"));
    await user.click(await within(dialog).findByRole("button", { name: /Start run/ }));
    expect(await screen.findByText(/has no input field "whoo"/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Run a workflow" })).toBeInTheDocument();
  });
});

describe("the chrome", () => {
  it("names the repo and the pool from the daemon", async () => {
    renderApp("/queue");
    expect(await screen.findByText("treel")).toBeInTheDocument();
    // The status bar says the pool size; the queue's running group says it too.
    expect((await screen.findAllByText(/8 agents/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/weft v0\.9\.0/)).toBeInTheDocument();
  });

  it("badges the queue with the number of outstanding questions", async () => {
    renderApp("/queue");
    const link = await screen.findByRole("link", { name: /Queue/ });
    expect(await within(link).findByText("1")).toBeInTheDocument();
  });
});
