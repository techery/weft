import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();
const sources = await Promise.all(
  ["packages/sdk/src/types.ts", "packages/sdk/src/ui.ts"].map(async (file) => ({
    file,
    text: await readFile(path.join(root, file), "utf8"),
  })),
);
const interfaces = new Map();
for (const { file, text } of sources) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement);
  }
}

const api = new Set();
walkInterface("Ctx", "ctx");

if (process.argv.includes("--list")) {
  console.log([...api].sort().join("\n"));
  process.exit(0);
}

const manifestPath = path.join(root, "examples/coverage.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const covered = new Set(Object.keys(manifest));
const missing = [...api].filter((key) => !covered.has(key)).sort();
const stale = [...covered].filter((key) => !api.has(key)).sort();
const absentFiles = [];
for (const [key, file] of Object.entries(manifest)) {
  if (typeof file !== "string") absentFiles.push(`${key}: path must be a string`);
  else await access(path.join(root, file)).catch(() => absentFiles.push(`${key}: ${file}`));
}
if (missing.length || stale.length || absentFiles.length) {
  if (missing.length) console.error(`Missing example coverage:\n${missing.join("\n")}`);
  if (stale.length) console.error(`Stale example coverage:\n${stale.join("\n")}`);
  if (absentFiles.length) console.error(`Missing example files:\n${absentFiles.join("\n")}`);
  process.exit(1);
}
console.log(`example coverage: ${api.size} public workflow surfaces mapped`);

function walkInterface(name, prefix) {
  const declaration = interfaces.get(name);
  if (!declaration) return;
  walkMembers(declaration.members, prefix, name);
}

function walkMembers(members, prefix, owner) {
  for (const member of members) {
    if (ts.isCallSignatureDeclaration(member)) {
      api.add(prefix);
      continue;
    }
    const name = propertyName(member.name);
    if (!name) continue;
    const key = `${prefix}.${name}`;
    if (ts.isMethodSignature(member)) {
      api.add(key);
      if (owner === "Ctx" && typeReferenceName(member.type) === "Pipeline") walkInterface("Pipeline", key);
      continue;
    }
    if (!ts.isPropertySignature(member)) continue;
    if (member.type && ts.isTypeLiteralNode(member.type)) {
      walkMembers(member.type.members, key, owner);
      continue;
    }
    const target = typeReferenceName(member.type);
    const nested = target ? interfaces.get(target) : undefined;
    if (
      nested &&
      [...nested.members].some((child) => ts.isMethodSignature(child) || ts.isCallSignatureDeclaration(child))
    ) {
      walkInterface(target, key);
    } else {
      api.add(key);
    }
  }
}

function propertyName(name) {
  if (!name) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function typeReferenceName(node) {
  return node && ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
    ? node.typeName.text
    : undefined;
}
