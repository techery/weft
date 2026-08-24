/**
 * `.weft/config.json` — the engine's own config input plus the few host-level knobs the
 * engine has no business knowing about (where workflows live, which bare imports they may
 * use). Every field is optional: a repo with no config file is a valid repo, and
 * {@link loadConfig} hands back `{}` for one.
 *
 * The file is validated on the way in, so a typo lands as an error naming the file
 * instead of a silently ignored setting that only shows up as odd behaviour later.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EngineConfigInput } from "@techery/weft-core";
import * as z from "zod";

/** The per-repo directory every host reads and writes: stores, workflows, derived index. */
export const WEFT_DIR = ".weft";

/** Config file name inside {@link WEFT_DIR}. */
export const CONFIG_FILE = "config.json";

export interface WeftConfig extends EngineConfigInput {
  workflows?: {
    /** Registry directory; relative paths resolve against the repo root. Default `.weft/workflows`. */
    dir?: string;
    /** Extra bare imports workflow code may use (`@techery/weft-sdk` is always allowed). */
    allowBare?: string[];
  };
}

/** Absolute path of the config file a given repo root would use. */
export function configPath(cwd: string): string {
  return join(cwd, WEFT_DIR, CONFIG_FILE);
}

// ---------------------------------------------------------------------------
// Schema — a mirror of EngineConfigInput, plus `workflows`
// ---------------------------------------------------------------------------

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const Risk = z.enum(["low", "medium", "high", "irreversible"]);
const ApprovalMode = z.enum(["auto", "ask"]);

// Nested sections are STRICT: a typo like `limits.stepTimoutMs` silently falling
// back to the default timeout defeats the point of validating at all. Forward
// compatibility lives at the TOP level only (see ConfigSchema's .loose()).
const ModelPrice = z.strictObject({
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
});

const ProviderConfig = z.strictObject({
  concurrency: z.number().int().positive().optional(),
  prices: z.record(z.string(), ModelPrice).optional(),
});

const Limits = z.strictObject({
  concurrency: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  stepTimeoutMs: z.number().int().positive().optional(),
  execTimeoutMs: z.number().int().positive().optional(),
  fetchTimeoutMs: z.number().int().positive().optional(),
  repair: z.number().int().nonnegative().optional(),
  agentGuideline: z.number().int().nonnegative().optional(),
  agentHard: z.number().int().positive().optional(),
  fanoutMax: z.number().int().positive().optional(),
  blobThresholdBytes: z.number().int().positive().optional(),
  maxDepth: z.number().int().positive().optional(),
});

/**
 * Loose on purpose: an unknown top-level key is carried through rather than rejected, so
 * a newer host's setting does not make the file unreadable to an older one.
 */
const ConfigSchema = z
  .object({
    defaults: z
      .strictObject({
        provider: z.string().optional(),
        model: z.string().optional(),
        effort: Effort.optional(),
      })
      .optional(),
    providers: z.record(z.string(), ProviderConfig).optional(),
    approvalPolicy: z
      .strictObject({
        tiers: z.partialRecord(Risk, ApprovalMode).optional(),
        actions: z.record(z.string(), ApprovalMode).optional(),
      })
      .optional(),
    fetchAllow: z.array(z.string()).optional(),
    limits: Limits.optional(),
    workflows: z
      .strictObject({
        dir: z.string().optional(),
        allowBare: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .loose();

/**
 * Read `<cwd>/.weft/config.json`. Absent file → `{}`. Malformed JSON or a field of the
 * wrong shape → an Error naming the file, because a config a host silently ignores is
 * worse than one that refuses to load.
 */
export async function loadConfig(cwd: string): Promise<WeftConfig> {
  const file = configPath(cwd);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isAbsent(err)) return {};
    throw new Error(`cannot read ${file}: ${messageOf(err)}`, { cause: err });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${messageOf(err)}`, { cause: err });
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`${file} must contain a JSON object`);
  }

  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} is not a valid weft config:\n${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((i) => `  ${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("\n");
}
