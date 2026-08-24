/**
 * `weft doctor` — everything that has to be true before a run can work, checked in the
 * order it bites: the runtime, git, the repo layout, provider credentials, and finally the
 * workflows themselves. Credentials are reported as hints, never read or echoed.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { configPath, GateError, loadWorkflow } from "@techery/weft-host";
import { Command } from "commander";
import pc from "picocolors";
import { allowBareOf, globalOptions, openWeft, workflowsDir } from "../context.ts";
import { table } from "../format.ts";
import { type CliIo, say } from "../io.ts";

const run = promisify(execFile);

/** The floor the packages declare in `engines.node`. */
const MIN_NODE = [22, 12] as const;

type Verdict = "ok" | "warn" | "fail";

interface Check {
  verdict: Verdict;
  label: string;
  detail: string;
}

export function doctorCommand(io: CliIo): Command {
  return new Command("doctor")
    .description("check the runtime, git, .weft layout, credentials, and the workflows")
    .action(async (_opts: unknown, cmd: Command) => {
      const { cwd } = globalOptions(cmd);
      const checks: Check[] = [nodeCheck(), await gitCheck()];

      const weft = await openWeft(cmd);
      try {
        checks.push(...layoutChecks(weft.weftDir, workflowsDir(weft), cwd));
        checks.push(...credentialChecks());

        const entries = await weft.registry.list().catch(() => []);
        if (entries.length === 0) {
          checks.push({ verdict: "warn", label: "registry", detail: "no workflows — try: weft new review" });
        }
        for (const entry of entries) {
          checks.push(await workflowCheck(entry, cwd, allowBareOf(weft)));
        }
        // registry.list() silently SKIPS files that fail to load: a broken
        // workflow beside a healthy one must not let doctor print "ready".
        const listed = new Set(entries.map((entry) => path.resolve(entry.file)));
        let files: string[] = [];
        try {
          files = (await readdir(workflowsDir(weft))).filter((f) => f.endsWith(".ts"));
        } catch (err) {
          // Only genuine ABSENCE is fine (layoutChecks already reports it). Any
          // other failure — EACCES, EIO, a stray FILE named "workflows" — hides
          // every workflow behind an empty scan, and "ready" over a directory
          // nobody can read is a lie.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            checks.push({
              verdict: "fail",
              label: "workflows",
              detail: `cannot read ${path.relative(cwd, workflowsDir(weft))}: ${(err as Error).message}`,
            });
          }
        }
        for (const file of files) {
          const full = path.resolve(workflowsDir(weft), file);
          if (listed.has(full)) continue;
          checks.push(await unlistedFileCheck(full, cwd, allowBareOf(weft)));
        }

        say(
          io,
          ...table(
            [],
            checks.map((c) => [mark(c.verdict), c.label, pc.dim(c.detail)]),
          ),
        );
        const failures = checks.filter((c) => c.verdict === "fail");
        if (failures.length > 0) {
          io.out(pc.red(`${failures.length} problem${failures.length === 1 ? "" : "s"} to fix`));
          process.exitCode = 1;
        } else {
          io.out(pc.green("ready"));
        }
      } finally {
        await weft.close();
      }
    });
}

function mark(verdict: Verdict): string {
  if (verdict === "ok") return pc.green("✓");
  return verdict === "warn" ? pc.yellow("!") : pc.red("✗");
}

function nodeCheck(): Check {
  const version = process.versions.node;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    verdict: ok ? "ok" : "fail",
    label: "node",
    detail: ok ? `v${version}` : `v${version} — weft needs >= ${MIN_NODE[0]}.${MIN_NODE[1]}`,
  };
}

async function gitCheck(): Promise<Check> {
  try {
    const { stdout } = await run("git", ["--version"]);
    return { verdict: "ok", label: "git", detail: stdout.trim() };
  } catch {
    return { verdict: "fail", label: "git", detail: "not on PATH — isolation and write steps need it" };
  }
}

function layoutChecks(weftDir: string, flows: string, cwd: string): Check[] {
  const rel = (p: string): string => path.relative(cwd, p) || ".";
  const config = configPath(cwd);
  return [
    {
      verdict: existsSync(weftDir) ? "ok" : "warn",
      label: ".weft",
      detail: existsSync(weftDir) ? rel(weftDir) : `${rel(weftDir)} not created yet — the first run makes it`,
    },
    {
      verdict: existsSync(flows) ? "ok" : "warn",
      label: "workflows",
      detail: existsSync(flows) ? rel(flows) : `${rel(flows)} missing — weft new <name> creates it`,
    },
    {
      verdict: "ok",
      label: "config",
      detail: existsSync(config) ? rel(config) : "none (defaults apply)",
    },
    {
      verdict: existsSync(path.join(cwd, ".git")) ? "ok" : "warn",
      label: "repo",
      detail: existsSync(path.join(cwd, ".git")) ? cwd : `${cwd} is not a git repo — git steps will fail`,
    },
  ];
}

/**
 * Presence only. The adapters pick up whatever login the local Claude Code / Codex CLI
 * already has, so an absent variable is a hint, not a failure.
 */
function credentialChecks(): Check[] {
  // Neither adapter is handed a key: each vendor SDK resolves its own credentials, and
  // both fall back to the CLI's stored login. So an absent variable is only half the
  // question — a `codex login` leaves an auth file that works just as well, and saying
  // otherwise sends people looking for a key they do not need.
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const codexKey = process.env.OPENAI_API_KEY;
  const codexAuth = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json");
  const codexLoggedIn = existsSync(codexAuth);

  return [
    {
      // Claude Code keeps its login in the OS keychain on macOS, so there is no file to
      // look for: report the variable, and say plainly that a CLI login also counts.
      verdict: claudeKey ? "ok" : "warn",
      label: "claude",
      detail: claudeKey
        ? "ANTHROPIC_API_KEY set"
        : "no ANTHROPIC_API_KEY — a `claude login` session also works",
    },
    {
      verdict: codexKey || codexLoggedIn ? "ok" : "warn",
      label: "codex",
      detail: codexKey
        ? "OPENAI_API_KEY set"
        : codexLoggedIn
          ? "signed in via `codex login`"
          : "no OPENAI_API_KEY and no `codex login` — do either",
    },
  ];
}

/**
 * A file the registry did not list is either a HELPER module (`./schemas.ts`
 * bundles cleanly but exports no workflow — fine, `weft check` classifies it the
 * same way) or genuinely broken, which must fail rather than hide behind the
 * registry's silence.
 */
async function unlistedFileCheck(
  file: string,
  cwd: string,
  allowBare: { allowBare?: string[] },
): Promise<Check> {
  const name = path.basename(file, ".ts");
  try {
    await loadWorkflow({ entry: file, ...allowBare });
    return { verdict: "ok", label: name, detail: path.relative(cwd, file) };
  } catch (err) {
    if (
      err instanceof GateError &&
      err.diagnostics.length > 0 &&
      err.diagnostics.every((d) => d.rule === "no-workflow-export")
    ) {
      return { verdict: "ok", label: name, detail: `${path.relative(cwd, file)} (module, not a workflow)` };
    }
    const count = err instanceof GateError ? err.diagnostics.length : 0;
    return {
      verdict: "fail",
      label: name,
      detail: `${count > 0 ? `${count} gate violation(s)` : (err as Error).message} — weft check ${name}`,
    };
  }
}

async function workflowCheck(
  entry: { name: string; file: string },
  cwd: string,
  allowBare: { allowBare?: string[] },
): Promise<Check> {
  try {
    await loadWorkflow({ entry: entry.file, ...allowBare });
    return { verdict: "ok", label: entry.name, detail: path.relative(cwd, entry.file) };
  } catch (err) {
    const count = err instanceof GateError ? err.diagnostics.length : 0;
    return {
      verdict: "fail",
      label: entry.name,
      detail: `${count > 0 ? `${count} gate violation(s)` : (err as Error).message} — weft check ${entry.name}`,
    };
  }
}
