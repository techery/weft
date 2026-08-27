import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { shallowDiff } from "../src/commands/diff.ts";
import {
  bunRunnerFor,
  DEFAULT_WORKFLOW_TEST_PATTERN,
  nodeRunnerFor,
  runnerFor,
  selectRunner,
} from "../src/commands/test.ts";
import { parseDynamicFlags } from "../src/flags.ts";
import { answerLine } from "../src/format.ts";
import type { CliIo } from "../src/io.ts";
import { buildProgram } from "../src/main.ts";

const run = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
  roots.length = 0;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface CliResult {
  lines: string[];
  text: string;
  exitCode: number | undefined;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Drive the real program with a collector for `io`. `process.exitCode` is captured and
 * restored so a command that marks itself failed does not take the test runner with it.
 */
async function cli(...argv: string[]): Promise<CliResult> {
  const lines: string[] = [];
  const io: CliIo = {
    out: (line) => lines.push(line.replace(ANSI, "")),
    err: (line) => lines.push(line.replace(ANSI, "")),
  };
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await buildProgram(io).exitOverride().parseAsync(argv, { from: "user" });
    return { lines, text: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    process.exitCode = before;
  }
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "weft-cli-"));
  roots.push(dir);
  return dir;
}

async function write(root: string, file: string, content: string): Promise<string> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  const workflowMain = file.match(/^(.*\/workflows\/[^/]+|examples\/(?:one|two)\/[^/]+)\/main\.ts$/);
  if (workflowMain?.[1]) {
    const packageDir = path.join(root, workflowMain[1]);
    await Promise.all([
      mkdir(path.join(packageDir, "lib"), { recursive: true }),
      mkdir(path.join(packageDir, "tests"), { recursive: true }),
      writeFile(path.join(packageDir, "CHANGELOG.md"), "# Test workflow changelog\n", "utf8"),
    ]);
  }
  await writeFile(target, content, "utf8");
  return target;
}

/** The run ids on disk, so a test never has to scrape one out of the output. */
async function runIds(root: string): Promise<string[]> {
  return (await readdir(path.join(root, ".weft", "runs"))).sort();
}

// ---------------------------------------------------------------------------
// Fixtures — workflows that touch no provider
// ---------------------------------------------------------------------------

/** ctx.bash + ctx.now only: a real end-to-end run with nothing to mock. */
const GREET = `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    description: "greets through the shell and stamps it with journaled time",
    input: z.object({ name: z.string().default("weft") }),
    output: z.object({ greeting: z.string(), at: z.number() }),
  },
  async (ctx, input) => {
    const echoed = await ctx.bash(\`echo hello \${input.name}\`, { key: "greet" });
    return { greeting: echoed.stdout.trim(), at: await ctx.now() };
  },
);
`;

const AUDIT = `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    description: "echoes back the input it was given",
    input: z.object({ base: z.string(), depth: z.number().default(1) }),
    output: z.object({ base: z.string(), depth: z.number(), at: z.number() }),
  },
  async (ctx, input) => ({ base: input.base, depth: input.depth, at: await ctx.now() }),
);
`;

const SHIP = `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    description: "asks a person before it ships",
    input: z.object({}),
    output: z.object({ shipped: z.boolean() }),
  },
  async (ctx) => {
    const verdict = await ctx.human.approve({ action: "ship the release", detail: "tag v1.0.0" });
    return { shipped: verdict.approved };
  },
);
`;

const BANNED = `import { defineWorkflow, z } from "@techery/weft-sdk";

const stamp = Date.now();

export default defineWorkflow(
  { description: "reads the clock directly", input: z.object({}), output: z.object({ stamp: z.number() }) },
  async () => ({ stamp }),
);
`;

const TRACKED = `import { defineWorkflow, z } from "@techery/weft-sdk";

export default defineWorkflow(
  {
    id: "tracked",
    name: "tracked",
    description: "has workflow-specific task fields",
    input: z.object({}),
    output: z.object({}),
    tasks: {
      extensions: z.object({ lane: z.enum(["api", "ui"]), estimate: z.number().int() }),
      semanticRevision: "tracked-task-fields-v2",
      schemaVersion: 2,
      migrate: (value) => value,
    },
  },
  async () => ({}),
);
`;

// ---------------------------------------------------------------------------

describe("weft run", () => {
  it("runs a workflow file end to end and leaves the run on disk", async () => {
    const root = await tempRoot();
    await write(root, "flows/greet.ts", GREET);

    const result = await cli("--cwd", root, "--mock", "run", "./flows/greet.ts");

    expect(result.text).toContain('"greeting": "hello weft"');
    expect(result.text).toContain("complete");
    expect(result.exitCode).toBeUndefined();

    const [runId] = await runIds(root);
    expect(runId).toBeDefined();
    const runDir = path.join(root, ".weft", "runs", runId as string);
    expect(existsSync(path.join(runDir, "journal.jsonl"))).toBe(true);
    expect(existsSync(path.join(runDir, "state.json"))).toBe(true);
    expect(result.text).toContain(runId as string);

    // The bash step really ran: its output is journaled, not synthesised.
    const journal = await readFile(path.join(runDir, "journal.jsonl"), "utf8");
    expect(journal).toContain("hello weft");
  });

  it("takes input from dynamic flags over --args, and ls/status/report see the run", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit/main.ts", AUDIT);

    const started = await cli(
      "--cwd",
      root,
      "--mock",
      "run",
      "audit",
      "--args",
      '{"base":"trunk","depth":9}',
      "--base",
      "main",
      "--depth",
      "3",
    );
    expect(started.text).toContain('"base": "main"');
    expect(started.text).toContain('"depth": 3');

    const [runId = ""] = await runIds(root);

    const listed = await cli("--cwd", root, "--mock", "ls");
    expect(listed.text).toContain("RUN");
    expect(listed.text).toContain("audit");
    expect(listed.text).toContain(runId);

    const status = await cli("--cwd", root, "--mock", "status", runId);
    expect(status.text).toContain("audit");
    expect(status.text).toContain("complete");
    expect(status.text).toContain('"base": "main"');

    const report = await cli("--cwd", root, "--mock", "report", runId);
    expect(report.text).toContain(`# audit — run ${runId}`);
    expect(report.text).toContain("**Status:** complete");
  });

  it("explains one step from the journal", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/greet/main.ts", GREET);
    await cli("--cwd", root, "--mock", "run", "greet", "--name", "ada");
    const [runId = ""] = await runIds(root);

    const explained = await cli("--cwd", root, "--mock", "explain", runId, "greet");
    expect(explained.text).toContain("greet");
    expect(explained.text).toContain("echo hello ada"); // the journaled payload
    expect(explained.text).toContain('"stdout": "hello ada"');
  });
});

describe("human in the loop", () => {
  it("suspends, prints the answer command, and completes over answer + resume", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/ship/main.ts", SHIP);

    const started = await cli("--cwd", root, "--mock", "run", "ship");
    const [runId = ""] = await runIds(root);
    expect(started.text).toContain("waiting_for_human");
    expect(started.text).toContain("ship the release");
    expect(started.text).toContain(`weft answer ${runId} h1 '{"approved":true}'`);

    // A separate engine, exactly as a later shell would have: the answer lands in the
    // journal and only the resume replays it into the waiting step.
    const answered = await cli("--cwd", root, "--mock", "answer", runId, "h1", '{"approved":true}');
    expect(answered.text).toContain("answered h1");

    const resumed = await cli("--cwd", root, "--mock", "resume", runId);
    expect(resumed.text).toContain('"shipped": true');
    expect(resumed.text).toContain("complete");
    expect(resumed.exitCode).toBeUndefined();
  });

  it("refuses to guess which request to answer when the id is missing", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/ship/main.ts", SHIP);
    await cli("--cwd", root, "--mock", "run", "ship");
    const [runId = ""] = await runIds(root);

    // One pending request: the id may be left out entirely.
    const answered = await cli("--cwd", root, "--mock", "answer", runId, '{"approved":false}');
    expect(answered.text).toContain("answered h1");

    // None left: nothing is invented, and the command reports failure.
    const again = await cli("--cwd", root, "--mock", "answer", runId, '{"approved":true}');
    expect(again.text).toContain("no pending requests");
    expect(again.exitCode).toBe(1);
  });
});

describe("--watch", () => {
  it("renders a live tree of phases and steps, and freezes the last frame", async () => {
    const root = await tempRoot();
    await write(
      root,
      ".weft/workflows/slow/main.ts",
      `import { defineWorkflow, z } from "@techery/weft-sdk";

      export default defineWorkflow(
        { description: "two phases of shell work", input: z.object({}), output: z.object({ done: z.boolean() }) },
        async (ctx) => {
          ctx.phase("Warm");
          await ctx.bash("sleep 0.4", { key: "warm" });
          ctx.phase("Work");
          await ctx.parallel([() => ctx.bash("sleep 0.6", { key: "work:a" })]);
          return { done: true };
        },
      );
      `,
    );

    const frames: string[] = [];
    const lines: string[] = [];
    let frozen = false;
    const io: CliIo = {
      out: (line) => lines.push(line.replace(ANSI, "")),
      live: (frame) => frames.push(frame.replace(ANSI, "")),
      liveDone: () => {
        frozen = true;
      },
    };
    await buildProgram(io)
      .exitOverride()
      .parseAsync(["--cwd", root, "--mock", "run", "slow", "--watch"], { from: "user" });

    expect(frames.length).toBeGreaterThan(1);
    expect(frozen).toBe(true);
    const last = frames[frames.length - 1] ?? "";
    expect(last).toContain("slow");
    expect(last).toContain("Warm");
    expect(last).toContain("Work");
    expect(last).toContain("complete");
    expect(lines.join("\n")).toContain('"done": true');
  });
});

describe("weft cancel", () => {
  it("cancels a suspended run and refreshes what ls reads", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/ship/main.ts", SHIP);
    await cli("--cwd", root, "--mock", "run", "ship");
    const [runId = ""] = await runIds(root);

    const cancelled = await cli("--cwd", root, "--mock", "cancel", runId);
    expect(cancelled.text).toContain("cancelled");

    const listed = await cli("--cwd", root, "--mock", "ls");
    expect(listed.text).toContain("cancelled");
    expect(listed.text).toContain("ship");
  });
});

describe("--mock", () => {
  it("fails an agent step loudly instead of inventing an answer", async () => {
    const root = await tempRoot();
    await write(
      root,
      ".weft/workflows/asks/main.ts",
      `import { defineWorkflow, z } from "@techery/weft-sdk";

      export default defineWorkflow(
        { description: "needs an agent", input: z.object({}), output: z.object({ verdict: z.string() }) },
        async (ctx) => ctx.agent("Is this fine?", { key: "verdict", schema: z.object({ verdict: z.string() }) }),
      );
      `,
    );

    const failed = await cli("--cwd", root, "--mock", "run", "asks");
    expect(failed.text).toContain("failed");
    expect(failed.text).toContain("no fixture matches");
    expect(failed.exitCode).toBe(1);
  });
});

describe("weft replay --dry", () => {
  it("reports what a resume would reuse without touching the journal", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit/main.ts", AUDIT);
    await cli("--cwd", root, "--mock", "run", "audit", "--base", "main");
    const [runId = ""] = await runIds(root);
    const before = await readFile(path.join(root, ".weft", "runs", runId, "journal.jsonl"), "utf8");

    const dry = await cli("--cwd", root, "--mock", "replay", runId, "--dry");
    expect(dry.text).toMatch(/hits\s+1/);
    expect(dry.text).toContain("diverged");
    expect(dry.text).toContain("replays to completion");

    const after = await readFile(path.join(root, ".weft", "runs", runId, "journal.jsonl"), "utf8");
    expect(after).toBe(before);
  });
});

describe("weft diff", () => {
  it("shows the step whose output changed between two runs", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/greet/main.ts", GREET);
    await cli("--cwd", root, "--mock", "run", "greet", "--name", "ada");
    await cli("--cwd", root, "--mock", "run", "greet", "--name", "grace");
    const ids = await runIds(root);
    expect(ids).toHaveLength(2);
    const [a = "", b = ""] = ids;

    const diffed = await cli("--cwd", root, "--mock", "diff", a, b);
    expect(diffed.text).toContain("~ greet");
    expect(diffed.text).toContain("stdout:");
    expect(diffed.text).toContain("hello ada");
    expect(diffed.text).toContain("hello grace");
    expect(diffed.text).toContain("1 of 1 step(s) differ");
  });
});

describe("weft check", () => {
  it("flags a banned global with its fix-it and fails", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/bad/main.ts", BANNED);

    const checked = await cli("--cwd", root, "--mock", "check", "bad", "--no-tsc");

    expect(checked.text).toContain("no-date-now");
    expect(checked.text).toContain("Date.now() is not allowed in workflow code");
    expect(checked.text).toContain("fix: Date.now() is unavailable - use ctx.now()");
    expect(checked.text).toContain("main.ts:3:15");
    expect(checked.text).toContain("1 violation");
    expect(checked.exitCode).toBe(1);
  });

  it("passes a clean workflow and ignores supporting modules under lib", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit/main.ts", `${AUDIT}\nimport "./lib/schema.ts";\n`);
    await write(
      root,
      ".weft/workflows/audit/lib/schema.ts",
      'import { z } from "@techery/weft-sdk";\nexport const N = z.number();\n',
    );

    const checked = await cli("--cwd", root, "--mock", "check", "--no-tsc");
    expect(checked.text).toContain("audit/main.ts");
    expect(checked.text).not.toContain("schema.ts");
    expect(checked.exitCode).toBeUndefined();
  });

  it("fails when the TypeScript pass reports a real error", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/broken-types/main.ts", `${AUDIT}\nimport "./lib/broken.ts";\n`);
    await write(root, ".weft/workflows/broken-types/lib/broken.ts", "export const value: string = 1;\n");

    const checked = await cli("--cwd", root, "--mock", "check");

    expect(checked.text).toContain("broken-types/main.ts");
    expect(checked.text).toContain("TS2322");
    expect(checked.exitCode).toBe(1);
  });
});

describe("weft new", () => {
  it("scaffolds a workflow that passes the gate, and never overwrites one", async () => {
    const root = await tempRoot();

    const created = await cli("--cwd", root, "--mock", "new", "review");
    expect(created.text).toContain("review/main.ts");
    expect(created.text).toContain("review/lib/schemas.ts");
    expect(created.text).toContain("review/tests/main.test.ts");
    expect(created.text).toContain("review/CHANGELOG.md");
    expect(existsSync(path.join(root, ".weft", "workflows", "review", "main.ts"))).toBe(true);
    expect(existsSync(path.join(root, ".weft", "workflows", "review", "lib", "schemas.ts"))).toBe(true);
    expect(existsSync(path.join(root, ".weft", "workflows", "review", "tests", "main.test.ts"))).toBe(true);
    expect(existsSync(path.join(root, ".weft", "workflows", "review", "CHANGELOG.md"))).toBe(true);

    const checked = await cli("--cwd", root, "--mock", "check", "review", "--no-tsc");
    expect(checked.text).toContain("review/main.ts");
    expect(checked.exitCode).toBeUndefined();

    const source = await readFile(path.join(root, ".weft", "workflows", "review", "main.ts"), "utf8");
    expect(source).toContain('id: "review"');
    expect(source).toContain('errors: "throw"');
    expect(source).toContain("ctx.all(");

    await expect(cli("--cwd", root, "--mock", "new", "review")).rejects.toThrow(/already exists/);
  });

  it("offers minimal and task-aware templates that both pass the gate", async () => {
    const simpleRoot = await tempRoot();
    await cli("--cwd", simpleRoot, "--mock", "new", "answer", "--template", "simple");
    expect(existsSync(path.join(simpleRoot, ".weft", "workflows", "answer", "lib", "index.ts"))).toBe(true);
    expect(
      (await cli("--cwd", simpleRoot, "--mock", "check", "answer", "--no-tsc")).exitCode,
    ).toBeUndefined();

    const taskRoot = await tempRoot();
    await cli("--cwd", taskRoot, "--mock", "new", "queue", "--template", "task");
    const taskSource = await readFile(path.join(taskRoot, ".weft", "workflows", "queue", "main.ts"), "utf8");
    expect(taskSource).toContain("defineTaskContract");
    expect((await cli("--cwd", taskRoot, "--mock", "check", "queue", "--no-tsc")).exitCode).toBeUndefined();
  });
});

describe("weft workflow", () => {
  it("lists definitions and inspects their schemas as JSON", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit/main.ts", AUDIT);

    const listed = await cli("--cwd", root, "--mock", "workflow", "list");
    expect(listed.text).toContain("audit");
    expect(listed.text).toContain("echoes back the input");

    const inspected = await cli("--cwd", root, "--mock", "workflow", "inspect", "audit", "--json");
    const contract = JSON.parse(inspected.text) as Record<string, unknown>;
    expect(contract).toMatchObject({
      id: "audit",
      name: "audit",
      tasks: null,
      defaults: {},
    });
    expect(contract.input).toMatchObject({ type: "object" });
    expect(contract.output).toMatchObject({ type: "object" });
  });

  it("inspects a workflow by its durable id when it differs from the callable name", async () => {
    const root = await tempRoot();
    await write(
      root,
      ".weft/workflows/audit/main.ts",
      AUDIT.replace(
        'description: "echoes back the input it was given",',
        'id: "durable-audit", description: "echoes back the input it was given",',
      ),
    );

    const inspected = await cli("--cwd", root, "--mock", "workflow", "inspect", "durable-audit", "--json");
    expect(JSON.parse(inspected.text)).toMatchObject({ id: "durable-audit", name: "audit" });
  });

  it("shows rejected workflow files and fails the listing", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/bad/main.ts", BANNED);

    const listed = await cli("--cwd", root, "--mock", "workflow", "list");
    expect(listed.text).toContain("bad/main.ts");
    expect(listed.text).toContain("Date.now() is not allowed");
    expect(listed.exitCode).toBe(1);
  });
});

describe("weft skill", () => {
  it("prints a SKILL.md, and one line for every command the program registers", async () => {
    // No .weft/ here on purpose: the skill is what you read BEFORE there is one, so this
    // command must never open the engine.
    const root = await tempRoot();
    const printed = await cli("--cwd", root, "skill");

    expect(printed.exitCode).toBeUndefined();
    expect(printed.lines[0]).toBe("---");
    expect(printed.text).toContain("name: weft");

    // The point of the assertion: a new command that nobody documented fails here.
    const commands = buildProgram({ out: () => {} })
      .commands.map((c) => c.name())
      .sort();
    expect(commands.length).toBeGreaterThan(10);
    for (const name of commands) expect(printed.text).toContain(`weft ${name}`);
  });

  it("is state-independent, writes only the document to stdout, and creates nothing", async () => {
    const root = await tempRoot();
    const stdout: string[] = [];
    const stderr: string[] = [];
    await buildProgram({ out: (line) => stdout.push(line), err: (line) => stderr.push(line) })
      .exitOverride()
      .parseAsync(["--cwd", root, "skill"], { from: "user" });

    expect(stderr).toEqual([]);
    expect(stdout[0]).toBe("---");
    expect(stdout.at(-1)).toMatch(/decide\.$/);
    expect(await readdir(root)).toEqual([]);
  });

  it("emits portable frontmatter, distribution guidance, and current authoring boundaries", async () => {
    const printed = await cli("--cwd", await tempRoot(), "skill");
    const frontmatterEnd = printed.lines.indexOf("---", 1);

    expect(frontmatterEnd).toBeGreaterThan(1);
    expect(printed.lines.slice(0, frontmatterEnd + 1).join("\n")).toMatch(
      /^---\nname: weft\ndescription: >-/,
    );
    for (const destination of [".claude/skills/weft/SKILL.md", ".agents/skills/weft/SKILL.md"]) {
      expect(printed.text).toContain(destination);
    }
    expect(printed.text).toContain("Codex repository skill");
    expect(printed.text).not.toContain(".codex/skills/weft/SKILL.md");
    for (const contract of [
      "ctx.tasks.observe",
      "ctx.tasks.upsert",
      "ctx.tasks.setCriterion",
      "ctx.ui.render",
      "defineUiView",
      "defineResultView",
      "defineTaskContract",
      "ctx.successes",
      "ctx.all",
      'errors: "throw"',
      "`signals`",
      "`taskSeeds`",
      "actionable TypeScript diagnostics fail",
      "main.ts",
      "not published to npm",
    ]) {
      expect(printed.text).toContain(contract);
    }
    expect(printed.text).not.toMatch(/\b(?:TODO|placeholder)\b/i);
    expect(printed.text).toContain("CHANGELOG.md");
    expect(printed.text).toContain("The directory basename is the callable registry name");
    expect(printed.text).toContain("fail closed on flat");
    expect(printed.text).toContain("ad-hoc path run");
    expect(printed.text).toContain("weft test .weft/workflows/review/tests");
    expect(printed.text).toMatch(/independently\s+authored review workflow/);
    expect(printed.text).not.toContain("The default review shape");
    expect(printed.text).toContain("By default, `low` auto-approves");
    expect(printed.text).toContain("configured action-pattern or risk-tier approval policies can require");
  });

  it("names the ctx replacement for every global the gate rejects", async () => {
    const root = await tempRoot();
    const printed = await cli("--cwd", root, "skill");

    for (const replacement of ["ctx.now()", "ctx.random()", "ctx.sleep(", "ctx.env.get(", "ctx.secret("]) {
      expect(printed.text).toContain(replacement);
    }
  });

  it("documents the implemented replay-key guard and direct child workflow identity", async () => {
    const printed = await cli("--cwd", await tempRoot(), "skill");

    expect(printed.text).toContain("one shared explicit-key namespace for `ctx.agent`, `ctx.workflow`");
    expect(printed.text).toContain("`ctx.exec`/`ctx.bash`, and `ctx.fetch`");
    expect(printed.text).toMatch(
      /Reusing a key across those calls or kinds in\s+one run fails with `invalid_input` before the second step dispatches/,
    );
    expect(printed.text).toMatch(
      /`ctx\.human\.ask`\/`approve`\/`review` keys are replay identities too, but human requests\s+are not included in that duplicate-key guard/,
    );
    expect(printed.text).toContain("do not rely on cross-kind rejection to catch a collision");
    expect(printed.text).not.toContain(
      "Every explicit step `key` must be unique across all calls and step kinds in one run",
    );
    expect(printed.text).toMatch(
      /A directly supplied child\s+definition must declare a stable `meta\.id` or `meta\.name`/,
    );
    expect(printed.text).toMatch(/prefer `meta\.id` for replay\s+identity/);
  });

  it("documents workflow discovery, task-write authority, fixture fallthrough, and exact stdlib schemas", async () => {
    const printed = await cli("--cwd", await tempRoot(), "skill");

    expect(printed.text).toContain("weft workflow list");
    expect(printed.text).toContain("weft workflow inspect <name-or-id> [--json]");
    expect(printed.text).toContain("weft new <name> --template simple");
    expect(printed.text).toContain("weft new <name> --template review");
    expect(printed.text).toContain("weft new <name> --template task");
    expect(printed.text).toContain("`--json` also exposes UI metadata");
    expect(printed.text).toContain('{ status: "failed", error }');
    expect(printed.text).toContain('{ status: "cancelled" }');
    expect(printed.text).toContain("by callable name or stable id");
    expect(printed.text).toContain('tasks: { mode: "write" }');
    expect(printed.text).toContain('tasks: { mode: "read", statuses: ["blocked"] }');
    expect(printed.text).toContain('meta.tasks.agentAccess: "write"');
    expect(printed.text).toContain("Side-effect fixture tables are interceptors, not a host sandbox");
    expect(printed.text).toContain("falls through to the real host implementation");
    expect(printed.text).toContain("CompletenessGapsSchema");
    expect(printed.text).toContain("`loopUntilDry` has no");
    expect(printed.text).toContain("result-schema export");
    expect(printed.text).not.toContain("Each also exports a schema builder");
  });
});

describe("weft test", () => {
  it("defaults to tests owned by workflow packages", () => {
    expect(DEFAULT_WORKFLOW_TEST_PATTERN).toBe(".weft/workflows/*/tests/**/*.test.ts");
  });

  it("uses the project's package manager without installing dependencies", async () => {
    const root = await tempRoot();

    expect(runnerFor(root, ["vitest", "run", "test/workflows"])).toEqual([
      "npx",
      ["--no-install", "vitest", "run", "test/workflows"],
    ]);

    await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    expect(runnerFor(root, ["vitest", "run", "test/workflows"])).toEqual([
      "pnpm",
      ["exec", "vitest", "run", "test/workflows"],
    ]);
  });

  it("falls back to Node's built-in test runner when Vitest is absent", async () => {
    const root = await tempRoot();

    expect(selectRunner(root, "auto")).toBe("node");
    expect(nodeRunnerFor("test/workflows", { watch: false, coverage: false })).toEqual([
      process.execPath,
      ["--experimental-strip-types", "--test", "test/workflows"],
    ]);
    expect(nodeRunnerFor("test/workflows/review.test.ts", { watch: true, coverage: true })).toEqual([
      process.execPath,
      [
        "--watch",
        "--experimental-strip-types",
        "--test",
        "--experimental-test-coverage",
        "test/workflows/review.test.ts",
      ],
    ]);
  });

  it("uses Bun's native runner for a Bun project without Vitest", async () => {
    const root = await tempRoot();
    await write(root, "bun.lock", "");

    expect(selectRunner(root, "auto")).toBe("bun");
    expect(bunRunnerFor("test/workflows", { watch: false, coverage: false })).toEqual([
      "bun",
      ["test", "test/workflows"],
    ]);
    expect(bunRunnerFor("test/workflows/review.test.ts", { watch: true, coverage: true })).toEqual([
      "bun",
      ["test", "--watch", "--coverage", "test/workflows/review.test.ts"],
    ]);
  });

  it("allows explicitly selecting Vitest or Node", async () => {
    const root = await tempRoot();

    expect(selectRunner(root, "node")).toBe("node");
    expect(selectRunner(root, "bun")).toBe("bun");
    expect(selectRunner(root, "vitest")).toBe("vitest");
  });
});

describe("weft doctor", () => {
  it("prints a line per check", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit/main.ts", AUDIT);

    const doctored = await cli("--cwd", root, "--mock", "doctor");
    expect(doctored.text).toContain("node");
    expect(doctored.text).toContain("git version");
    expect(doctored.text).toContain("workflows");
    expect(doctored.text).toContain("claude");
    expect(doctored.text).toContain("codex");
    expect(doctored.text).toContain("audit");
    expect(doctored.text).toContain("ready");
  });

  it("loads workflows from repeatable extra directories", async () => {
    const root = await tempRoot();
    await write(root, "examples/one/greet/main.ts", GREET);
    await write(root, "examples/two/audit/main.ts", AUDIT);

    const checked = await cli(
      "--cwd",
      root,
      "--extra-workflow-dir",
      "examples/one",
      "--extra-workflow-dir",
      "examples/two",
      "--mock",
      "check",
      "--no-tsc",
    );
    expect(checked.text).toContain("examples/one/greet/main.ts");
    expect(checked.text).toContain("examples/two/audit/main.ts");

    const started = await cli(
      "--cwd",
      root,
      "--extra-workflow-dir",
      "examples/one",
      "--mock",
      "run",
      "greet",
      "--name",
      "extra",
    );
    expect(started.text).toContain("complete");
  });
});

describe("weft doctor with package failures", () => {
  it("a helper module under lib is fine — doctor stays ready", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit/main.ts", `${AUDIT}\nimport "./lib/schema.ts";\n`);
    await write(
      root,
      ".weft/workflows/audit/lib/schema.ts",
      'import * as z from "zod";\nexport const S = z.object({});\n',
    );

    const doctored = await cli("--cwd", root, "--mock", "doctor");
    expect(doctored.text).toContain("audit/main.ts");
    expect(doctored.text).toContain("ready");
  });

  it("reports a BROKEN file the registry silently skipped instead of printing ready", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit/main.ts", AUDIT);
    await write(root, ".weft/workflows/broken/main.ts", "export default {{{ not typescript");

    const doctored = await cli("--cwd", root, "--mock", "doctor");
    expect(doctored.text).toContain("audit");
    expect(doctored.text).toContain("broken");
    expect(doctored.text).toContain("problem");
    expect(doctored.text).not.toContain("ready");
  });

  it("an UNREADABLE workflow directory fails instead of printing ready over an empty scan", async () => {
    const root = await tempRoot();
    // A stray FILE where the directory belongs: existsSync says "present", the
    // registry scan and readdir both error — swallowed as "no workflows", the
    // old doctor finished ready with every real workflow invisible.
    await mkdir(path.join(root, ".weft"), { recursive: true });
    await writeFile(path.join(root, ".weft", "workflows"), "not a directory\n");

    const doctored = await cli("--cwd", root, "--mock", "doctor");
    expect(doctored.text).toContain("cannot read");
    expect(doctored.text).toContain("problem");
    expect(doctored.text).not.toContain("ready");
    expect(doctored.exitCode).toBe(1);

    // `weft check` swallowed the same failure into "nothing to check" and
    // exited 0 — CI would pass having validated no workflow at all.
    await expect(cli("--cwd", root, "--mock", "check", "--no-tsc")).rejects.toThrow(/cannot read/);
  });
});

describe("diff field presence", () => {
  it("an absent field and an explicit null are DIFFERENT outputs", () => {
    expect(shallowDiff({ a: null }, {})).toHaveLength(1);
    expect(shallowDiff({}, { a: null })).toHaveLength(1);
    expect(shallowDiff({ a: null }, { a: null })).toHaveLength(0);
    expect(shallowDiff({ a: 1 }, { a: 1 })).toHaveLength(0);
  });
});

describe("errors", () => {
  it("explains an unknown workflow instead of starting a run", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit/main.ts", AUDIT);
    await expect(cli("--cwd", root, "--mock", "run", "nope")).rejects.toThrow(/unknown workflow "nope"/);
  });

  it("rejects a --reuse mode that is not content or key", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit/main.ts", AUDIT);
    await expect(
      cli("--cwd", root, "--mock", "run", "audit", "--reuse", "sometimes", "--base", "x"),
    ).rejects.toThrow(/invalid --reuse/);
  });

  it("fails a run whose workflow throws, and points at the next command", async () => {
    const root = await tempRoot();
    await write(
      root,
      ".weft/workflows/boom/main.ts",
      `import { defineWorkflow, z } from "@techery/weft-sdk";

      export default defineWorkflow(
        { description: "always fails", input: z.object({}), output: z.object({}) },
        async (ctx) => {
          await ctx.bash("exit 3", { key: "boom" });
          throw new Error("nope");
        },
      );
      `,
    );
    const failed = await cli("--cwd", root, "--mock", "run", "boom");
    expect(failed.text).toContain("failed");
    expect(failed.text).toContain("weft explain");
    expect(failed.exitCode).toBe(1);
  });
});

describe("bin/weft.js", () => {
  it("registers tsx and prints usage", async () => {
    const bin = fileURLToPath(new URL("../bin/weft.js", import.meta.url));
    const { stdout } = await run(process.execPath, [bin, "--help"]);
    expect(stdout).toContain("weft");
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("doctor");
  });
});

describe("weft task", () => {
  it("manages a workflow-bound task and validates its extension schema", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/tracked/main.ts", TRACKED);

    const created = await cli(
      "--cwd",
      root,
      "--mock",
      "task",
      "--workflow",
      "tracked",
      "--actor",
      "planner",
      "--json",
      "create",
      "--title",
      "Wire task context",
      "--description",
      "Share context between agent steps",
      "--dedupe-key",
      "context-wiring",
      "--tag",
      "context",
      "--file",
      "packages/core/src/ctx.ts",
      "--acceptance",
      "agents receive the CLI command",
      "--extensions",
      '{"lane":"api","estimate":3}',
    );
    const task = JSON.parse(created.text) as {
      id: string;
      revision: number;
      dedupeKey?: string;
      extensionSchemaVersion: number;
    };
    expect(task.id).toMatch(/^task-[0-9a-f]{32}$/);
    expect(task.dedupeKey).toBe("context-wiring");
    expect(task.extensionSchemaVersion).toBe(2);
    expect(existsSync(path.join(root, ".weft/tasks/tracked/.workflow.json"))).toBe(true);

    const upserted = await cli(
      "--cwd",
      root,
      "--mock",
      "task",
      "--workflow",
      "tracked",
      "--json",
      "upsert",
      "--dedupe-key",
      "context-wiring",
      "--title",
      "Wire reviewed task context",
      "--description",
      "Share verified context between agent steps",
      "--tag",
      "reviewed",
      "--file",
      "packages/core/src/ctx.ts",
      "--acceptance",
      "agents receive bounded task context",
      "--extensions",
      '{"lane":"api","estimate":5}',
      "--note",
      "review recurrence",
    );
    expect(JSON.parse(upserted.text)).toMatchObject({
      id: task.id,
      title: "Wire reviewed task context",
      revision: 2,
    });
    expect(JSON.parse(upserted.text)).not.toHaveProperty("appliedOperations");

    const filtered = await cli(
      "--cwd",
      root,
      "--mock",
      "task",
      "--workflow",
      "tracked",
      "--json",
      "list",
      "--dedupe-key",
      "context-wiring",
      "--file",
      "packages/core/src/ctx.ts",
    );
    expect(JSON.parse(filtered.text)).toHaveLength(1);

    const occurrence = JSON.parse(
      (
        await cli(
          "--cwd",
          root,
          "--mock",
          "task",
          "--workflow",
          "tracked",
          "--json",
          "upsert",
          "--dedupe-key",
          "context-wiring",
          "--title",
          "Wire reviewed task context",
          "--description",
          "Share verified context between agent steps",
          "--note",
          "seen again without replacing collections",
        )
      ).text,
    ) as { tags: string[]; relatedFiles: string[]; acceptanceCriteria: unknown[] };
    expect(occurrence.tags).toEqual(["reviewed"]);
    expect(occurrence.relatedFiles).toEqual(["packages/core/src/ctx.ts"]);
    expect(occurrence.acceptanceCriteria).toHaveLength(1);

    await cli(
      "--cwd",
      root,
      "--mock",
      "task",
      "--workflow",
      "tracked",
      "note",
      task.id,
      "daemon endpoint is wired",
    );
    await cli("--cwd", root, "--mock", "task", "--workflow", "tracked", "accept", task.id, "1");
    const listed = await cli("--cwd", root, "--mock", "task", "--workflow", "tracked", "--json", "list");
    const tasks = JSON.parse(listed.text) as Array<{
      notes: Array<{ text: string }>;
      acceptanceCriteria: Array<{ met: boolean }>;
      extensions: unknown;
    }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.notes.map((note) => note.text)).toEqual([
      "review recurrence",
      "seen again without replacing collections",
      "daemon endpoint is wired",
    ]);
    expect(tasks[0]?.acceptanceCriteria[0]?.met).toBe(true);
    expect(tasks[0]?.extensions).toEqual({ lane: "api", estimate: 5 });

    await expect(
      cli(
        "--cwd",
        root,
        "--mock",
        "task",
        "--workflow",
        "tracked",
        "create",
        "--title",
        "Duplicate context",
        "--description",
        "Must keep one logical task",
        "--dedupe-key",
        "context-wiring",
        "--extensions",
        '{"lane":"api","estimate":3}',
      ),
    ).rejects.toThrow(/dedupe key/);

    const schema = await cli("--cwd", root, "--mock", "task", "--workflow", "tracked", "schema");
    expect(JSON.parse(schema.text)).toMatchObject({
      type: "object",
      properties: { lane: { type: "string" }, estimate: { type: "integer" } },
    });

    await cli(
      "--cwd",
      root,
      "--mock",
      "task",
      "--workflow",
      "tracked",
      "update",
      task.id,
      "--clear-tags",
      "--clear-files",
      "--clear-acceptance",
    );
    const cleared = JSON.parse(
      (await cli("--cwd", root, "--mock", "task", "--workflow", "tracked", "--json", "show", task.id)).text,
    ) as { tags: string[]; relatedFiles: string[]; acceptanceCriteria: unknown[] };
    expect(cleared).toMatchObject({ tags: [], relatedFiles: [], acceptanceCriteria: [] });

    const invalidStatus = await cli(
      "--cwd",
      root,
      "--mock",
      "task",
      "--workflow",
      "tracked",
      "list",
      "--status",
      "in-progress",
    ).catch(() => undefined);
    expect(invalidStatus).toBeUndefined();

    const invalid = await cli(
      "--cwd",
      root,
      "--mock",
      "task",
      "--workflow",
      "tracked",
      "create",
      "--title",
      "Bad task",
      "--description",
      "wrong extension",
      "--extensions",
      '{"lane":"docs","estimate":1}',
    ).catch((err: unknown) => String(err));
    expect(String(invalid)).toMatch(/task extensions failed/);
  });

  it("resolves a stable workflow id before another workflow's callable name", async () => {
    const root = await tempRoot();
    await write(
      root,
      ".weft/workflows/name-owner/main.ts",
      `import { defineWorkflow, z } from "@techery/weft-sdk";
export default defineWorkflow(
  {
    id: "name-owner",
    name: "shared-ref",
    description: "owns the callable name",
    input: z.object({}),
    output: z.object({}),
    tasks: {
      extensions: z.object({ lane: z.literal("name") }),
      semanticRevision: "name-owner-v1",
    },
  },
  async () => ({}),
);`,
    );
    await write(
      root,
      ".weft/workflows/id-owner/main.ts",
      `import { defineWorkflow, z } from "@techery/weft-sdk";
export default defineWorkflow(
  {
    id: "shared-ref",
    name: "id-owner",
    description: "owns the durable id",
    input: z.object({}),
    output: z.object({}),
    tasks: {
      extensions: z.object({ lane: z.literal("id") }),
      semanticRevision: "id-owner-v1",
    },
  },
  async () => ({}),
);`,
    );

    const created = await cli(
      "--cwd",
      root,
      "--mock",
      "task",
      "--workflow",
      "shared-ref",
      "--json",
      "create",
      "--title",
      "Use stable identity",
      "--description",
      "Never cross workflow task namespaces",
      "--extensions",
      '{"lane":"id"}',
    );

    expect(JSON.parse(created.text)).toMatchObject({
      workflowId: "shared-ref",
      extensions: { lane: "id" },
    });
    const namespace = JSON.parse(
      await readFile(path.join(root, ".weft/tasks/shared-ref/.workflow.json"), "utf8"),
    ) as { id: string; name: string };
    expect(namespace).toMatchObject({ id: "shared-ref", name: "id-owner" });
    expect(existsSync(path.join(root, ".weft/tasks/name-owner"))).toBe(false);
  });

  it("reopens a durable namespace for a path or stdin workflow without a registry file", async () => {
    const root = await tempRoot();
    const namespaceFile = ".weft/tasks/inline-review/.workflow.json";
    await write(
      root,
      namespaceFile,
      `${JSON.stringify({
        schemaVersion: 1,
        id: "inline-review",
        name: "inline",
        extensionSchemaDeclared: false,
        extensionSchema: null,
      })}\n`,
    );
    const created = await cli(
      "--cwd",
      root,
      "--mock",
      "task",
      "--workflow",
      "inline-review",
      "--json",
      "create",
      "--title",
      "Persist inline context",
      "--description",
      "Keep the namespace after the run process exits",
    );
    const task = JSON.parse(created.text) as { id: string };
    const shown = await cli(
      "--cwd",
      root,
      "--mock",
      "task",
      "--workflow",
      "inline-review",
      "--json",
      "show",
      task.id,
    );
    expect(JSON.parse(shown.text)).toMatchObject({ workflowId: "inline-review" });

    await write(
      root,
      namespaceFile,
      `${JSON.stringify({
        schemaVersion: 1,
        id: "inline-review",
        name: "inline",
        extensionSchemaDeclared: true,
        extensionSchema: { type: "object", properties: { lane: { type: "string" } } },
      })}\n`,
    );
    await expect(
      cli(
        "--cwd",
        root,
        "--mock",
        "task",
        "--workflow",
        "inline-review",
        "update",
        task.id,
        "--extensions",
        '{"lane":"api"}',
      ),
    ).rejects.toThrow(/workflow definition is not available to validate/);
  });
});

describe("answerLine", () => {
  it("addresses the request's OWNING run, not the run being shown", () => {
    const schema = { type: "object", properties: { go: { type: "boolean" } }, required: ["go"] };
    // Request ids are run-local (h1, h2…): two parallel children can both hold
    // an h1, and a parent-addressed answer would land on whichever pends first.
    expect(answerLine("parent01", { id: "h1", kind: "ask", question: "?", schema, runId: "child007" })).toBe(
      `weft answer child007 h1 '{"go":true}'`,
    );
    expect(answerLine("parent01", { id: "h1", kind: "ask", question: "?", schema })).toBe(
      `weft answer parent01 h1 '{"go":true}'`,
    );
  });
});

describe("parseDynamicFlags", () => {
  it("keeps values a number cannot represent exactly as strings", () => {
    // Each of these used to start the run against something else.
    expect(parseDynamicFlags(["--sha", "1e5"])).toEqual({ sha: "1e5" });
    expect(parseDynamicFlags(["--version", "1.20"])).toEqual({ version: "1.20" });
    expect(parseDynamicFlags(["--code", "007"])).toEqual({ code: "007" });
    expect(parseDynamicFlags(["--hex", "0x10"])).toEqual({ hex: "0x10" });
    expect(parseDynamicFlags(["--blank", " "])).toEqual({ blank: " " });
  });

  it("still coerces plain numbers and booleans", () => {
    expect(parseDynamicFlags(["--depth", "2"])).toEqual({ depth: 2 });
    expect(parseDynamicFlags(["--ratio", "-3.5"])).toEqual({ ratio: -3.5 });
    expect(parseDynamicFlags(["--force", "true"])).toEqual({ force: true });
    expect(parseDynamicFlags(["--watch"])).toEqual({ watch: true });
    expect(parseDynamicFlags(["--no-cache"])).toEqual({ cache: false });
  });

  it("refuses a repeated flag rather than silently keeping the last", () => {
    expect(() => parseDynamicFlags(["--base", "a", "--base", "b"])).toThrow(/more than once/);
  });

  it("treats __proto__ as an ordinary field, not a prototype write", () => {
    const out = parseDynamicFlags(["--__proto__", "x"]);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("camel-cases kebab flags", () => {
    expect(parseDynamicFlags(["--base-ref", "main"])).toEqual({ baseRef: "main" });
  });
});
