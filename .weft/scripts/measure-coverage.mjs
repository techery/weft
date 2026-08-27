#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const options = parseArgs(process.argv.slice(2));
const reportsDirectory = "coverage/weft-workflow";
await rm(reportsDirectory, { recursive: true, force: true });

const args = [
  "exec",
  "vitest",
  "run",
  "--coverage.enabled",
  "--coverage.provider=v8",
  "--coverage.reporter=json-summary",
  "--coverage.reportOnFailure",
  `--coverage.reportsDirectory=${reportsDirectory}`,
  `--coverage.thresholds.statements=${options.statements}`,
  `--coverage.thresholds.branches=${options.branches}`,
  `--coverage.thresholds.functions=${options.functions}`,
  `--coverage.thresholds.lines=${options.lines}`,
  ...options.include.flatMap((pattern) => ["--coverage.include", pattern]),
  ...options.exclude.flatMap((pattern) => ["--coverage.exclude", pattern]),
];

const run = await spawnBuffered("pnpm", args);
let summary;
try {
  summary = JSON.parse(await readFile(path.join(reportsDirectory, "coverage-summary.json"), "utf8"));
} catch {
  summary = undefined;
}

const totals = metricSet(summary?.total);
const files = Object.entries(summary ?? {})
  .filter(([file]) => file !== "total")
  .map(([file, metrics]) => ({
    path: relative(file),
    statements: pct(metrics?.statements),
    branches: pct(metrics?.branches),
    functions: pct(metrics?.functions),
    lines: pct(metrics?.lines),
  }))
  .filter((file) => Math.min(file.statements, file.branches, file.functions, file.lines) < 100)
  .sort((a, b) => weakest(a) - weakest(b) || compare(a.path, b.path))
  .slice(0, 80);

const ready = summary?.total !== undefined;
const thresholdsMet =
  totals.statements.pct >= options.statements &&
  totals.branches.pct >= options.branches &&
  totals.functions.pct >= options.functions &&
  totals.lines.pct >= options.lines;
const passed = ready && run.exitCode === 0 && thresholdsMet;
const failure = passed ? "" : tail(`${run.stderr}\n${run.stdout}`.trim(), 16_000);

process.stdout.write(
  `${JSON.stringify({ ready, passed, exitCode: run.exitCode, totals, files, failure })}\n`,
);
process.exitCode = passed ? 0 : 1;

function parseArgs(args) {
  const parsed = {
    statements: 90,
    branches: 85,
    functions: 90,
    lines: 90,
    include: [],
    exclude: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) fail(`missing value for ${flag}`);
    if (flag === "--include") parsed.include.push(value);
    else if (flag === "--exclude") parsed.exclude.push(value);
    else if (flag === "--statements") parsed.statements = percentage(value, flag);
    else if (flag === "--branches") parsed.branches = percentage(value, flag);
    else if (flag === "--functions") parsed.functions = percentage(value, flag);
    else if (flag === "--lines") parsed.lines = percentage(value, flag);
    else fail(`unknown argument ${flag}`);
    index += 1;
  }
  if (parsed.include.length === 0) fail("at least one --include pattern is required");
  return parsed;
}

function percentage(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) fail(`${flag} must be between 0 and 100`);
  return number;
}

function metricSet(value) {
  return {
    statements: metric(value?.statements),
    branches: metric(value?.branches),
    functions: metric(value?.functions),
    lines: metric(value?.lines),
  };
}

function metric(value) {
  return {
    covered: integer(value?.covered),
    total: integer(value?.total),
    pct: pct(value),
  };
}

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function pct(value) {
  const number = Number(value?.pct);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : 0;
}

function relative(file) {
  const value = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
  return value.split(path.sep).join("/");
}

function weakest(file) {
  return Math.min(file.statements, file.branches, file.functions, file.lines);
}

function tail(value, max) {
  return value.length <= max ? value : `...[truncated]\n${value.slice(-max)}`;
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function spawnBuffered(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = bounded(stdout, chunk, 2_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = bounded(stderr, chunk, 2_000_000);
    });
    child.on("error", (error) => resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function bounded(current, chunk, max) {
  const next = `${current}${chunk}`;
  return next.length <= max ? next : next.slice(-max);
}

function fail(message) {
  process.stdout.write(
    `${JSON.stringify({ ready: false, passed: false, exitCode: 2, totals: metricSet(), files: [], failure: message })}\n`,
  );
  process.exit(2);
}
