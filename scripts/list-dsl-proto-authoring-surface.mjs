#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();
const packageRoot = path.join(root, "packages/dsl-proto");
const configPath = path.join(packageRoot, "tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) fail(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot, undefined, configPath);
if (parsed.errors.length > 0) {
  fail(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
}

const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
  fail(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
}
const checker = program.getTypeChecker();
const facade = requiredSource("packages/dsl-proto/src/facade.ts");
const index = requiredSource("packages/dsl-proto/src/index.ts");
const checks = requiredSource("packages/dsl-proto/src/core/checks.ts");
const composition = requiredSource("packages/dsl-proto/src/core/composition.ts");
const observers = requiredSource("packages/dsl-proto/src/core/observers.ts");
const operations = requiredSource("packages/dsl-proto/src/core/operations.ts");
const workflow = requiredSource("packages/dsl-proto/src/core/workflow.ts");
const mode = process.argv[2] ?? "--ctx";

if (mode === "--ctx") {
  const surface = new Set();
  collectExportedType(facade, "WorkflowCtx", "ctx", surface);
  collectExportedType(facade, "WorkspaceCtx", "ctx", surface);
  collectOwnInterface(facade, "CandidateWorkspaceContext", "candidate", surface);
  collectOwnInterface(facade, "ParallelLaneContext", "lane", surface);
  collectOwnInterface(facade, "SequenceItemContext", "scope", surface);
  collectExportedType(workflow, "ReviewCtx", "reviewCtx", surface);
  collectExportedType(composition, "ReviewParallelLaneContext", "reviewLane", surface);
  collectExportedType(operations, "OperationRunContext", "operationCtx", surface);
  collectExportedType(observers, "ObserverRunContext", "observerCtx", surface);
  collectExportedType(checks, "CheckRunContext", "checkCtx", surface);
  console.log([...surface].sort().join("\n"));
} else if (mode === "--builders") {
  console.log(authoringValues(index).sort().join("\n"));
} else if (mode === "--advanced-ctx") {
  const ordinary = new Set();
  const advanced = new Set();
  collectExportedType(facade, "WorkflowCtx", "ctx", ordinary);
  collectExportedType(facade, "WorkspaceCtx", "ctx", ordinary);
  collectExportedType(workflow, "WorkflowCtx", "ctx", advanced);
  collectExportedType(workflow, "WorkspaceCtx", "ctx", advanced);
  collectOwnInterface(facade, "ParallelLaneContext", "lane", ordinary);
  collectOwnInterface(facade, "SequenceItemContext", "scope", ordinary);
  collectOwnInterface(composition, "ParallelLaneContext", "lane", advanced);
  collectOwnInterface(composition, "SequenceItemContext", "scope", advanced);
  console.log(
    [...advanced]
      .filter((surface) => !ordinary.has(surface))
      .sort()
      .join("\n"),
  );
} else {
  fail(`unknown mode: ${mode}; expected --ctx, --builders, or --advanced-ctx`);
}

function collectExportedType(source, name, prefix, output) {
  const module = checker.getSymbolAtLocation(source);
  const exported = module && checker.getExportsOfModule(module).find((symbol) => symbol.name === name);
  if (!exported) fail(`${source.fileName}: missing export ${name}`);
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const declaration = symbol.declarations?.[0];
  if (!declaration) fail(`${source.fileName}: missing declaration for ${name}`);
  const type = ts.isTypeAliasDeclaration(declaration)
    ? checker.getTypeFromTypeNode(declaration.type)
    : checker.getDeclaredTypeOfSymbol(symbol);
  collectMembers(type, prefix, output, new Set());
}

function collectMembers(type, prefix, output, seen) {
  if (type.isUnionOrIntersection()) {
    for (const member of type.types) collectMembers(member, prefix, output, seen);
    return;
  }

  const identity = `${prefix}:${type.id}`;
  if (seen.has(identity)) return;
  seen.add(identity);

  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) output.add(prefix);
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) continue;
    const memberType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const memberPath = `${prefix}.${property.name}`;
    const callable = checker.getSignaturesOfType(memberType, ts.SignatureKind.Call).length > 0;
    const container = isApiContainer(memberType);
    if (callable) output.add(memberPath);
    if (container) collectMembers(memberType, memberPath, output, seen);
    else if (!callable) output.add(memberPath);
    if (memberPath === "ctx.pipeline") {
      for (const signature of checker.getSignaturesOfType(memberType, ts.SignatureKind.Call)) {
        collectMembers(checker.getReturnTypeOfSignature(signature), memberPath, output, seen);
      }
    }
  }
}

function isApiContainer(type) {
  if (type.isUnionOrIntersection()) return type.types.some(isApiContainer);
  if (!hasPrototypeDeclaration(type)) return false;
  if (
    type.flags &
    (ts.TypeFlags.Any |
      ts.TypeFlags.Unknown |
      ts.TypeFlags.Never |
      ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.ESSymbolLike |
      ts.TypeFlags.Null |
      ts.TypeFlags.Undefined)
  ) {
    return false;
  }
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) return true;
  return checker.getPropertiesOfType(type).some((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) return false;
    const memberType = checker.getTypeOfSymbolAtLocation(property, declaration);
    return checker.getSignaturesOfType(memberType, ts.SignatureKind.Call).length > 0;
  });
}

function hasPrototypeDeclaration(type) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return Boolean(
    symbol?.declarations?.some((declaration) =>
      path.resolve(declaration.getSourceFile().fileName).startsWith(`${packageRoot}${path.sep}`),
    ),
  );
}

function collectOwnInterface(source, name, prefix, output) {
  const declaration = source.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (!declaration) fail(`${source.fileName}: missing interface ${name}`);
  for (const member of declaration.members) {
    const memberName = propertyName(member.name);
    if (!memberName) continue;
    const memberPath = `${prefix}.${memberName}`;
    output.add(memberPath);
  }
}

function authoringValues(source) {
  const values = new Set();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.moduleSpecifier.text === "zod") continue;
    }
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      values.add(element.name.text);
      const exported = checker
        .getExportsOfModule(checker.getSymbolAtLocation(source))
        .find((symbol) => symbol.name === element.name.text);
      if (!exported) continue;
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration) continue;
      const valueType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
      for (const property of checker.getPropertiesOfType(valueType)) {
        const propertyDeclaration = property.valueDeclaration ?? property.declarations?.[0];
        if (!propertyDeclaration) continue;
        const propertyType = checker.getTypeOfSymbolAtLocation(property, propertyDeclaration);
        if (checker.getSignaturesOfType(propertyType, ts.SignatureKind.Call).length > 0) {
          values.add(`${element.name.text}.${property.name}`);
        }
      }
    }
  }
  return [...values];
}

function propertyName(name) {
  if (!name) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function requiredSource(relativePath) {
  const absolute = path.join(root, relativePath);
  const source = program.getSourceFile(absolute);
  if (!source) fail(`TypeScript program omitted ${relativePath}`);
  return source;
}

function fail(message) {
  console.error(`DSL prototype surface inventory failed: ${message}`);
  process.exit(1);
}
