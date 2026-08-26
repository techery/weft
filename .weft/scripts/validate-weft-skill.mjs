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
const frontmatter = frontmatterOf(skill);
if (!/^name:\s*weft\s*$/m.test(frontmatter)) fail("frontmatter must declare name: weft");
if (!/^description:\s*(?:\S|[>|])/m.test(frontmatter)) fail("frontmatter must declare a description");
if (/\b(?:TODO|TBD|PLACEHOLDER)\b/i.test(skill)) fail("generated skill contains unfinished placeholder text");
if (skill.slice(frontmatter.length + 6).trim().length < 500)
  fail("generated skill body is too small to teach Weft");
if (!skill.includes("weft check") || !skill.includes("weft run") || !skill.includes("weft skill")) {
  fail("generated skill omits required authoring/distribution commands");
}

console.log(`weft skill valid: ${Buffer.byteLength(skill, "utf8")} bytes`);

function frontmatterOf(skill) {
  if (!skill.startsWith("---\n")) fail("output must start with YAML frontmatter");
  const end = skill.indexOf("\n---\n", 4);
  if (end < 0) fail("frontmatter is not closed");
  return skill.slice(4, end);
}

function fail(message) {
  console.error(`weft skill invalid: ${message}`);
  process.exit(1);
}
