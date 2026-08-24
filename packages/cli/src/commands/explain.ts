/**
 * `weft explain <run> <key|seq>` — everything the journal holds about one step: how it was
 * routed, what it was actually sent, what it returned, what it cost, how many attempts it
 * took. This is the command that answers "why did that agent say that".
 */
import { Command } from "commander";
import pc from "picocolors";
import { openWeft } from "../context.ts";
import { compactTokens, jsonBlock, shortAge, stepLabel } from "../format.ts";
import { type CliIo, say, stepMark } from "../io.ts";
import { findStep, payloadOf, readRecords, resolveOutput } from "../runio.ts";

export function explainCommand(io: CliIo): Command {
  return new Command("explain")
    .description("show one step: route, prompt/payload, output, usage, attempts")
    .argument("<run>", "run id")
    .argument("<step>", "step key, label, or sequence number")
    .action(async (runId: string, target: string, _opts: unknown, cmd: Command) => {
      const weft = await openWeft(cmd);
      try {
        const state = await weft.engine.state(runId);
        const step = findStep(state.steps, target);
        if (!step) {
          const known = state.steps.map((s) => stepLabel(s)).join(", ") || "none";
          throw new Error(`run ${runId}: no step ${JSON.stringify(target)} (steps: ${known})`);
        }
        const records = await readRecords(weft, runId);

        say(
          io,
          `${stepMark(step.status)} ${pc.bold(stepLabel(step))}  ${pc.dim(`${step.kind} · seq ${step.seq}`)}`,
          pc.dim(
            [
              step.phase ? `phase ${step.phase}` : "no phase",
              step.route
                ? `${step.route.provider}${step.route.model ? `/${step.route.model}` : ""}`
                : "local",
              step.route?.effort ? `effort ${step.route.effort}` : "",
              step.attempts !== undefined ? `${step.attempts} attempt(s)` : "",
              step.endedAt !== undefined ? shortAge(step.endedAt - step.startedAt) : "running",
            ]
              .filter((part) => part !== "")
              .join(" · "),
          ),
        );
        if (step.usage) {
          const { input, output, cacheRead, usd } = step.usage;
          io.out(
            pc.dim(
              `usage ${compactTokens(input)} in · ${compactTokens(output)} out` +
                `${cacheRead ? ` · ${compactTokens(cacheRead)} cached` : ""}${usd ? ` · $${usd.toFixed(2)}` : ""}`,
            ),
          );
        }

        const payload = payloadOf(records, step.seq);
        if (payload !== undefined) {
          const prompt = promptOf(payload);
          if (prompt !== undefined) {
            say(io, pc.bold("prompt"), prompt);
            const rest = { ...(payload as Record<string, unknown>) };
            delete rest.prompt;
            say(io, pc.bold("options"), jsonBlock(rest));
          } else {
            say(io, pc.bold("payload"), jsonBlock(payload));
          }
        }

        if (step.error) {
          say(io, `${pc.red("error")} ${step.error.code}: ${step.error.message}`);
        }
        if (step.status === "ok") {
          say(io, pc.bold("output"), jsonBlock(await resolveOutput(weft, step.output)));
        }
        if (step.patchRef) io.out(pc.dim(`patch ${step.patchRef}`));
        if (step.childRunId) io.out(pc.dim(`child run ${step.childRunId} — weft status ${step.childRunId}`));
      } finally {
        await weft.close();
      }
    });
}

/** Agent steps journal their final prompt; showing it raw beats showing it JSON-escaped. */
function promptOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const prompt = (payload as { prompt?: unknown }).prompt;
  return typeof prompt === "string" ? prompt : undefined;
}
