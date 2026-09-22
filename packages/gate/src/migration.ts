import ts from "typescript";
import type { GateDiagnostic } from "./rules.ts";

/** Advisory syntax checks only: they do not infer aliases, prove effects, or reject workflows. */
export function workflowMigrationWarnings(source: string, file = "<workflow>"): GateDiagnostic[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const warnings: GateDiagnostic[] = [];
  const add = (node: ts.Node, rule: string, message: string, fixIt: string) => {
    const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    warnings.push({ rule, message, fixIt, file, line: position.line + 1, column: position.character + 1 });
  };
  const property = (node: ts.ObjectLiteralExpression, name: string) =>
    node.properties.find(
      (entry) =>
        entry.name &&
        (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
        entry.name.text === name,
    );
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^@techery\/weft-dsl-proto(?:\/|$)/.test(node.moduleSpecifier.text)
    ) {
      add(
        node,
        "migration-preview-import",
        "This import targets the declaration-only DSL preview.",
        "Use @techery/weft-sdk for runnable workflows; use weft skill --preview only for proposal/type-design work.",
      );
    }
    if (ts.isCallExpression(node)) {
      const name = accessPath(node.expression);
      if (name === "ctx.successes")
        add(
          node,
          "migration-optional-lanes",
          "ctx.successes discards failed lanes; confirm that this work is optional.",
          "Use ctx.parallel.all for required work, or inspect every ctx.parallel.settled outcome before accepting partial results.",
        );
      if (
        name === "ctx.parallel" &&
        node.arguments[0] &&
        ts.isArrayLiteralExpression(node.arguments[0]) &&
        node.arguments[0].elements.some(
          (element) => ts.isCallExpression(element) || ts.isAwaitExpression(element),
        )
      ) {
        add(
          node,
          "migration-eager-parallel",
          "Calls in this array are evaluated before ctx.parallel receives them.",
          "Pass items with a mapper or an array of thunks so the runtime can enforce concurrency.",
        );
      }
      const definition =
        name === "defineCheck" ? node.arguments[0] : name === "ctx.check" ? node.arguments[1] : undefined;
      if (
        name === "ctx.check.fn" ||
        (definition &&
          ts.isObjectLiteralExpression(definition) &&
          (property(definition, "run") || property(definition, "fn")) &&
          !property(definition, "revision"))
      ) {
        add(
          node,
          "migration-check-revision",
          "An unrevisioned callback check safely executes again on resume.",
          "Use a named defineCheck with an explicit revision when check meaning or trusted prior evidence needs a durable identity.",
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return warnings;
}

function accessPath(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const parent = accessPath(node.expression);
    return parent ? `${parent}.${node.name.text}` : undefined;
  }
  return undefined;
}
