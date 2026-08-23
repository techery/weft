import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
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
const GREET = `import { defineWorkflow, z } from "@weft/sdk";

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

const AUDIT = `import { defineWorkflow, z } from "@weft/sdk";

export default defineWorkflow(
  {
    description: "echoes back the input it was given",
    input: z.object({ base: z.string(), depth: z.number().default(1) }),
    output: z.object({ base: z.string(), depth: z.number(), at: z.number() }),
  },
  async (ctx, input) => ({ base: input.base, depth: input.depth, at: await ctx.now() }),
);
`;

const SHIP = `import { defineWorkflow, z } from "@weft/sdk";

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

const BANNED = `import { defineWorkflow, z } from "@weft/sdk";

const stamp = Date.now();

export default defineWorkflow(
  { description: "reads the clock directly", input: z.object({}), output: z.object({ stamp: z.number() }) },
  async () => ({ stamp }),
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
    await write(root, ".weft/workflows/audit.ts", AUDIT);

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
    await write(root, ".weft/workflows/greet.ts", GREET);
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
    await write(root, ".weft/workflows/ship.ts", SHIP);

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
    await write(root, ".weft/workflows/ship.ts", SHIP);
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
      ".weft/workflows/slow.ts",
      `import { defineWorkflow, z } from "@weft/sdk";

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
    await write(root, ".weft/workflows/ship.ts", SHIP);
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
      ".weft/workflows/asks.ts",
      `import { defineWorkflow, z } from "@weft/sdk";

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
    await write(root, ".weft/workflows/audit.ts", AUDIT);
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
    await write(root, ".weft/workflows/greet.ts", GREET);
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
    await write(root, ".weft/workflows/bad.ts", BANNED);

    const checked = await cli("--cwd", root, "--mock", "check", "bad", "--no-tsc");

    expect(checked.text).toContain("no-date-now");
    expect(checked.text).toContain("Date.now() is not allowed in workflow code");
    expect(checked.text).toContain("fix: Date.now() is unavailable - use ctx.now()");
    expect(checked.text).toMatch(/bad\.ts:3:15/);
    expect(checked.text).toContain("1 violation");
    expect(checked.exitCode).toBe(1);
  });

  it("passes a clean workflow and names helper modules as such", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit.ts", AUDIT);
    await write(
      root,
      ".weft/workflows/schemas.ts",
      'import { z } from "@weft/sdk";\nexport const N = z.number();\n',
    );

    const checked = await cli("--cwd", root, "--mock", "check", "--no-tsc");
    expect(checked.text).toContain("audit.ts");
    expect(checked.text).toContain("schemas.ts (module, not a workflow)");
    expect(checked.exitCode).toBeUndefined();
  });
});

describe("weft new", () => {
  it("scaffolds a workflow that passes the gate, and never overwrites one", async () => {
    const root = await tempRoot();

    const created = await cli("--cwd", root, "--mock", "new", "review");
    expect(created.text).toContain("review.ts");
    expect(created.text).toContain("schemas.ts");
    expect(existsSync(path.join(root, ".weft", "workflows", "review.ts"))).toBe(true);
    expect(existsSync(path.join(root, ".weft", "workflows", "schemas.ts"))).toBe(true);

    const checked = await cli("--cwd", root, "--mock", "check", "review", "--no-tsc");
    expect(checked.text).toContain("review.ts");
    expect(checked.exitCode).toBeUndefined();

    await expect(cli("--cwd", root, "--mock", "new", "review")).rejects.toThrow(/already exists/);
  });
});

describe("weft doctor", () => {
  it("prints a line per check", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit.ts", AUDIT);

    const doctored = await cli("--cwd", root, "--mock", "doctor");
    expect(doctored.text).toContain("node");
    expect(doctored.text).toContain("git version");
    expect(doctored.text).toContain("workflows");
    expect(doctored.text).toContain("claude");
    expect(doctored.text).toContain("codex");
    expect(doctored.text).toContain("audit");
    expect(doctored.text).toContain("ready");
  });
});

describe("errors", () => {
  it("explains an unknown workflow instead of starting a run", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit.ts", AUDIT);
    await expect(cli("--cwd", root, "--mock", "run", "nope")).rejects.toThrow(/unknown workflow "nope"/);
  });

  it("rejects a --reuse mode that is not content or key", async () => {
    const root = await tempRoot();
    await write(root, ".weft/workflows/audit.ts", AUDIT);
    await expect(
      cli("--cwd", root, "--mock", "run", "audit", "--reuse", "sometimes", "--base", "x"),
    ).rejects.toThrow(/invalid --reuse/);
  });

  it("fails a run whose workflow throws, and points at the next command", async () => {
    const root = await tempRoot();
    await write(
      root,
      ".weft/workflows/boom.ts",
      `import { defineWorkflow, z } from "@weft/sdk";

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
