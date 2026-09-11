/**
 * `weft answer <run> [req] [json]` — the durable half of human-in-the-loop. The run does
 * not have to be alive: with no process holding it, the answer is appended to the journal
 * and served to the step when `weft resume` replays it.
 *
 * With no JSON, the journaled JSON Schema is rendered as prompts — enum becomes a select,
 * boolean a confirm, string/number a text field, an object a walk over its properties.
 * Anything deeper than that is asked for as raw JSON: guessing at a nested shape with a
 * wizard is worse than showing the schema and taking the value.
 */
import type { PendingRequest, Weft } from "@techery/weft-host";
import { Command } from "commander";
import pc from "picocolors";
import { openWeft } from "../context.ts";
import { parseJsonValue } from "../flags.ts";
import { jsonBlock, pendingLines, sampleJson } from "../format.ts";
import { type CliIo, say } from "../io.ts";
import { refreshProjections } from "../runio.ts";

export function answerCommand(io: CliIo): Command {
  return new Command("answer")
    .description("answer a pending human request (interactive when no JSON is given)")
    .argument("<run>", "run id")
    .argument("[req]", "request id; omitted when exactly one is pending")
    .argument("[json]", "the answer as JSON; omitted to answer interactively")
    .action(
      async (
        runId: string,
        req: string | undefined,
        json: string | undefined,
        _opts: unknown,
        cmd: Command,
      ) => {
        const weft = await openWeft(cmd);
        try {
          // `weft answer 7f3a '{"approved":true}'` — the id is optional, so a lone JSON
          // argument lands in its place. Read it back out rather than making people pad it.
          const loneJson = json === undefined && req !== undefined && looksLikeJson(req);
          const answerJson = loneJson ? req : json;
          const requestId = loneJson ? undefined : req;

          const request = await pickRequest(io, weft, runId, requestId);
          if (!request) return;

          const value =
            answerJson !== undefined ? parseJsonValue(answerJson, "answer") : await promptForAnswer(request);
          if (value === undefined) {
            io.out(pc.dim("cancelled — nothing was answered"));
            return;
          }
          // Submit to the run that OWNS the request: ids are run-local, so a
          // parent-addressed answer could land on a sibling child's request
          // with the same id (and be validated against the wrong schema).
          await weft.engine.answer(request.runId ?? runId, request.id, value);
          await refreshProjections(weft, runId);
          say(
            io,
            `${pc.green("answered")} ${request.id}  ${jsonBlock(value).replace(/\n\s*/g, " ")}`,
            pc.dim(`then: weft resume ${runId}`),
          );
        } finally {
          await weft.close();
        }
      },
    );
}

function looksLikeJson(text: string): boolean {
  return /^[[{"]/.test(text.trim()) || /^(true|false|null|-?\d)/.test(text.trim());
}

/**
 * With no id: the single pending request, or the list and a non-zero exit — picking one
 * for the caller when there are several is exactly the kind of guess that answers the
 * wrong question.
 */
async function pickRequest(
  io: CliIo,
  weft: Weft,
  runId: string,
  req: string | undefined,
): Promise<PendingRequest | undefined> {
  const pending = await weft.engine.pending(runId);
  if (req !== undefined) {
    // Ids are run-local, so a parent-addressed lookup can hit SEVERAL children:
    // answering "the first one" would resolve a request the caller never read.
    const hits = pending.filter((p) => p.id === req);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      io.out(`request ${req} is pending in ${hits.length} runs — use the owning run id:`);
      for (const request of hits) say(io, ...pendingLines(runId, request));
      process.exitCode = 1;
      return undefined;
    }
    const known = pending.map((p) => p.id).join(", ") || "none";
    throw new Error(`run ${runId}: no pending request ${req} (pending: ${known})`);
  }
  if (pending.length === 1) return pending[0];
  if (pending.length === 0) {
    io.out(pc.dim(`run ${runId} has no pending requests`));
    process.exitCode = 1;
    return undefined;
  }
  io.out(`${pending.length} pending requests — name the one to answer:`);
  for (const request of pending) say(io, ...pendingLines(runId, request));
  process.exitCode = 1;
  return undefined;
}

// ---------------------------------------------------------------------------
// Interactive rendering of a journaled JSON Schema
// ---------------------------------------------------------------------------

type Clack = typeof import("@clack/prompts");

/** `undefined` means the person cancelled; `null` is a legitimate answer, so it cannot mean that. */
async function promptForAnswer(request: PendingRequest): Promise<unknown> {
  const clack: Clack = await import("@clack/prompts");
  clack.intro(`${request.kind}: ${request.question}`);
  if (request.detail) clack.note(request.detail, "detail");
  try {
    const value = await promptForSchema(clack, request.schema, request.question);
    if (value === undefined) {
      clack.cancel("cancelled");
      return undefined;
    }
    clack.outro(`answering ${request.id}`);
    return value;
  } catch (err) {
    clack.cancel((err as Error).message);
    throw err;
  }
}

async function promptForSchema(clack: Clack, schema: unknown, message: string): Promise<unknown> {
  const s = asObject(schema);
  if (!s) return askJson(clack, message, schema);

  if (Array.isArray(s.enum)) {
    const options = s.enum.map((value) => ({ value, label: String(value) }));
    return unwrap(clack, await clack.select({ message, options }));
  }
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "boolean":
      return unwrap(clack, await clack.confirm({ message }));
    case "string":
      return unwrap(
        clack,
        await clack.text({ message, ...(s.description ? { placeholder: String(s.description) } : {}) }),
      );
    case "number":
    case "integer": {
      const raw = unwrap(clack, await clack.text({ message, placeholder: "a number" }));
      if (typeof raw !== "string") return raw;
      // Number("") is 0 — an empty submission must not silently become zero.
      if (raw.trim() === "" || !Number.isFinite(Number(raw))) throw new Error(`"${raw}" is not a number`);
      return Number(raw);
    }
    case "object":
      return promptForObject(clack, s);
    default:
      return askJson(clack, message, schema);
  }
}

async function promptForObject(clack: Clack, schema: Record<string, unknown>): Promise<unknown> {
  const props = asObject(schema.properties);
  if (!props || Object.keys(props).length === 0) return askJson(clack, "value", schema);
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(props)) {
    const label = required.has(key) ? key : `${key} (optional)`;
    const value = await promptForSchema(clack, sub, label);
    if (value === undefined) return undefined;
    // An untouched optional field stays absent: "" is a value, and a schema that wants a
    // string would take it, which is not what an empty prompt meant.
    if (!required.has(key) && value === "") continue;
    out[key] = value;
  }
  return out;
}

/** The escape hatch: show the schema, take JSON. */
async function askJson(clack: Clack, message: string, schema: unknown): Promise<unknown> {
  clack.note(jsonBlock(schema), "schema");
  const raw = unwrap(
    clack,
    await clack.text({ message: `${message} (JSON)`, placeholder: sampleJson(schema) }),
  );
  if (typeof raw !== "string") return raw;
  return parseJsonValue(raw, "answer");
}

function unwrap(clack: Clack, value: unknown): unknown {
  return clack.isCancel(value) ? undefined : value;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
