/** `weft workflow` — discover definitions and inspect their executable contracts. */
import path from "node:path";
import { toWireSchema } from "@techery/weft-core";
import { type AnySchema, isZodSchema, z } from "@techery/weft-sdk";
import { Command } from "commander";
import pc from "picocolors";
import { openWeft } from "../context.ts";
import { table } from "../format.ts";
import { type CliIo, say } from "../io.ts";

interface InspectOptions {
  json?: boolean;
}

export function workflowCommand(io: CliIo): Command {
  const command = new Command("workflow").description("list workflows and inspect their contracts");

  command
    .command("list")
    .alias("ls")
    .description("list loadable workflows and rejected files")
    .action(async (_opts: unknown, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const inspection = await weft.registry.listWithIssues();
        if (inspection.entries.length === 0) {
          io.out(pc.dim("no loadable workflows — scaffold one with: weft new <name>"));
        } else {
          say(
            io,
            ...table(
              ["NAME", "ID", "DESCRIPTION", "FILE"],
              inspection.entries.map((entry) => [
                entry.name,
                entry.id,
                entry.description,
                path.relative(weft.cwd, entry.file),
              ]),
            ),
          );
        }
        for (const issue of inspection.issues) {
          io.out(`${pc.red("✗")} ${path.relative(weft.cwd, issue.file)} ${pc.dim(issue.error)}`);
        }
        if (inspection.issues.length > 0) process.exitCode = 1;
      } finally {
        await weft.close();
      }
    });

  command
    .command("inspect")
    .description("show input, output, task, routing, and UI contracts")
    .argument("<name-or-id>", "workflow name or stable id")
    .option("--json", "emit machine-readable JSON")
    .action(async (name: string, opts: InspectOptions, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const loaded = await weft.registry.loadIdentity(name);
        const { def } = loaded;
        const input = inspectSchema(def.meta.input, "input");
        const output = inspectSchema(def.meta.output, "output");
        const taskExtensions = def.meta.tasks?.extensions
          ? inspectSchema(def.meta.tasks.extensions, "input")
          : undefined;
        const contract = {
          id: def.meta.id ?? loaded.name,
          name: def.meta.name ?? loaded.name,
          description: def.meta.description,
          file: path.relative(weft.cwd, loaded.file),
          buildHash: loaded.buildHash,
          defaults: def.meta.defaults ?? {},
          input: input.json,
          output: output.json,
          tasks: def.meta.tasks
            ? {
                schemaVersion: def.meta.tasks.schemaVersion ?? 1,
                semanticRevision: def.meta.tasks.semanticRevision ?? null,
                agentAccess: def.meta.tasks.agentAccess ?? "read",
                extensions: taskExtensions?.json ?? null,
              }
            : null,
          ui: loaded.uiCatalog.assets.map((asset) => ({
            id: asset.id,
            mode: asset.mode,
            revision: asset.revision,
          })),
          warnings: [
            ...input.lints.map((warning) => `input: ${warning}`),
            ...output.lints.map((warning) => `output: ${warning}`),
            ...(taskExtensions?.lints.map((warning) => `tasks.extensions: ${warning}`) ?? []),
          ],
        };
        if (opts.json) {
          io.out(JSON.stringify(contract, null, 2));
          return;
        }
        say(
          io,
          `${pc.bold(contract.name)} (${contract.id})`,
          contract.description,
          pc.dim(contract.file),
          "",
          pc.bold("Input schema"),
          JSON.stringify(contract.input, null, 2),
          "",
          pc.bold("Output schema"),
          JSON.stringify(contract.output, null, 2),
          "",
          pc.bold("Defaults"),
          JSON.stringify(contract.defaults, null, 2),
          "",
          pc.bold("Tasks"),
          JSON.stringify(contract.tasks, null, 2),
          ...(contract.warnings.length > 0
            ? ["", pc.yellow("Schema warnings"), ...contract.warnings.map((warning) => `- ${warning}`)]
            : []),
        );
      } finally {
        await weft.close();
      }
    });

  return command;
}

function inspectSchema(schema: AnySchema, io: "input" | "output") {
  const wire = toWireSchema(schema);
  if (!isZodSchema(schema)) return wire;
  try {
    const json = z.toJSONSchema(schema as z.ZodType, {
      io,
      unrepresentable: "any",
      reused: "inline",
    }) as Record<string, unknown>;
    delete json.$schema;
    return { ...wire, json };
  } catch {
    return wire;
  }
}
