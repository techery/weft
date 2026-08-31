#!/usr/bin/env node
import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
let result;
try {
  result = await run(process.execPath, ["packages/cli/bin/weft.js", "skill"], {
    cwd: process.cwd(),
    maxBuffer: 2 * 1024 * 1024,
  });
} catch (error) {
  fail(`weft skill failed: ${error.stderr || error.message}`);
}

if (result.stderr.trim()) fail(`weft skill wrote to stderr: ${result.stderr.trim()}`);
const skill = result.stdout;
const prototypeBlock = boundedSection(
  skill,
  "<!-- weft-dsl-proto-reference:start -->",
  "<!-- weft-dsl-proto-reference:end -->",
);
const advancedPrototypeBlock = boundedSection(
  prototypeBlock,
  "#### Advanced-only `ctx` additions",
  "<!-- weft-dsl-proto-reference:end -->",
);
const sdkSkill = skill.replace(prototypeBlock, "");
let surfaceResult;
try {
  surfaceResult = await run(process.execPath, ["scripts/check-example-coverage.mjs", "--list"], {
    cwd: process.cwd(),
    maxBuffer: 2 * 1024 * 1024,
  });
} catch (error) {
  fail(`Ctx surface inventory failed: ${error.stderr || error.message}`);
}
const ctxSurfaces = surfaceResult.stdout.trim().split("\n").filter(Boolean);
for (const surface of ctxSurfaces) {
  if (!hasApiToken(sdkSkill, surface)) fail(`generated skill omits runnable SDK Ctx surface: ${surface}`);
}
for (const surface of await inventory("--ctx")) {
  if (!hasApiToken(prototypeBlock, surface)) {
    fail(`generated skill omits DSL prototype context surface: ${surface}`);
  }
}
for (const builder of await inventory("--builders")) {
  if (!hasApiToken(prototypeBlock, builder)) {
    fail(`generated skill omits DSL prototype authoring value: ${builder}`);
  }
}
if (!hasApiToken(prototypeBlock, "z")) {
  fail("generated skill omits DSL prototype schema helper: z");
}
for (const surface of await inventory("--advanced-ctx")) {
  if (!hasApiToken(advancedPrototypeBlock, surface)) {
    fail(`generated skill omits advanced DSL prototype context surface: ${surface}`);
  }
}
const frontmatter = frontmatterOf(skill);
if (!/^name:\s*weft\s*$/m.test(frontmatter)) fail("frontmatter must declare name: weft");
if (!/^description:\s*(?:\S|[>|])/m.test(frontmatter)) fail("frontmatter must declare a description");
if (/\b(?:TODO|TBD|PLACEHOLDER)\b/i.test(skill)) fail("generated skill contains unfinished placeholder text");
if (skill.slice(frontmatter.length + 6).trim().length < 500)
  fail("generated skill body is too small to teach Weft");
if (!skill.includes("weft check") || !skill.includes("weft run") || !skill.includes("weft skill")) {
  fail("generated skill omits required authoring/distribution commands");
}
for (const required of [
  ".weft/workflows/<name>/",
  "main.ts",
  "lib/",
  "tests/",
  "CHANGELOG.md",
  "The directory basename is the callable registry name",
  "fail closed on flat",
  "ad-hoc path run",
]) {
  if (!skill.includes(required)) fail(`generated skill omits workflow package guidance: ${required}`);
}
for (const required of [
  "providerOptions",
  "providerRequirements",
  "ctx.sequence",
  'kind: "file"',
  "review.detailed",
  "mock({ strict: true",
  "fixture.sequence",
  "journal.neverRan",
  "nothing lands until `ctx.integrate()`",
]) {
  if (!sdkSkill.includes(required)) fail(`generated skill omits current API guidance: ${required}`);
}
for (const required of [
  "@techery/weft-dsl-proto",
  "Declaration-only prototype in this checkout",
  "Never copy prototype syntax into an SDK workflow and claim it runs",
]) {
  if (!skill.includes(required)) fail(`generated skill omits DSL prototype boundary: ${required}`);
}
for (const required of [
  "ctx.agent(planner, issue",
  'failure: "return"',
  "ctx.workspace.snapshot",
  ".mapEffect",
  "a phase labels effects",
  "prototype step owns a callback",
  "needs no separate `.stage(...)` layer",
  "sameSnapshot",
  "assertUnchanged",
  "A `subject` is simply the thing",
  "no author-maintained task-contract version, revision, or migration chain",
]) {
  if (!prototypeBlock.includes(required)) fail(`generated skill omits DSL prototype guidance: ${required}`);
}
for (const required of [
  "defineAgent",
  "definePrompt",
  "ctx.agent.detailed",
  "ctx.phase",
  'onError: "null"',
]) {
  if (!sdkSkill.includes(required)) fail(`generated skill omits runnable SDK guidance: ${required}`);
}

console.log(`weft skill valid: ${Buffer.byteLength(skill, "utf8")} bytes`);

function frontmatterOf(skill) {
  if (!skill.startsWith("---\n")) fail("output must start with YAML frontmatter");
  const end = skill.indexOf("\n---\n", 4);
  if (end < 0) fail("frontmatter is not closed");
  return skill.slice(4, end);
}

async function inventory(mode) {
  try {
    const inventoryResult = await run(
      process.execPath,
      ["scripts/list-dsl-proto-authoring-surface.mjs", mode],
      { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
    );
    return inventoryResult.stdout.trim().split("\n").filter(Boolean);
  } catch (error) {
    fail(`DSL prototype surface inventory failed: ${error.stderr || error.message}`);
  }
}

function boundedSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) fail(`generated skill omits section marker: ${startMarker}`);
  if (text.indexOf(startMarker, start + startMarker.length) >= 0) {
    fail(`generated skill duplicates section marker: ${startMarker}`);
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end < 0) fail(`generated skill omits section marker: ${endMarker}`);
  if (text.indexOf(endMarker, end + endMarker.length) >= 0) {
    fail(`generated skill duplicates section marker: ${endMarker}`);
  }
  return text.slice(start, end + endMarker.length);
}

function hasApiToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.])${escaped}(?![A-Za-z0-9_.])`, "m").test(text);
}

function fail(message) {
  console.error(`weft skill invalid: ${message}`);
  process.exit(1);
}
