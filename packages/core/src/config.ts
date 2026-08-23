/**
 * Engine configuration: routing defaults, approval policy, limits, price table.
 * Everything has a sensible default; hosts load overrides from weft.config.
 */
import { cpus } from "node:os";
import type { Effort, Risk } from "@weft/sdk";

export type ApprovalMode = "auto" | "ask";

export interface ApprovalPolicy {
  /** Override per risk tier; defaults: low → auto, medium/high → ask, irreversible → ask (+ typed confirm). */
  tiers?: Partial<Record<Risk, ApprovalMode>>;
  /** Glob patterns over gate action strings, e.g. { "git.push origin/wip/*": "auto" }. First match wins. */
  actions?: Record<string, ApprovalMode>;
}

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

export interface ProviderConfig {
  concurrency?: number;
  prices?: Record<string, ModelPrice>;
}

export interface EngineLimits {
  /** Global concurrent-step cap; default min(16, cpus − 2), at least 1. */
  concurrency: number;
  maxTurns: number;
  /** Default per-agent-step timeout (ms). */
  stepTimeoutMs: number;
  /** Default exec/bash timeout (ms). */
  execTimeoutMs: number;
  fetchTimeoutMs: number;
  /** Schema repair attempts in the same session. */
  repair: number;
  /** Soft warn / hard fail on total agent steps per run tree. */
  agentGuideline: number;
  agentHard: number;
  /** parallel/pipeline max items per call. */
  fanoutMax: number;
  /** Outputs larger than this (bytes) go to the blob store. */
  blobThresholdBytes: number;
  /** Sub-workflow nesting depth. */
  maxDepth: number;
}

export interface EngineConfig {
  defaults: { provider: string; model?: string; effort?: Effort };
  providers: Record<string, ProviderConfig>;
  approvalPolicy: ApprovalPolicy;
  /** Hostname allow-list for ctx.fetch; undefined → all hosts allowed (set it to lock down). */
  fetchAllow?: string[];
  limits: EngineLimits;
}

export type EngineConfigInput = {
  defaults?: Partial<EngineConfig["defaults"]>;
  providers?: Record<string, ProviderConfig>;
  approvalPolicy?: ApprovalPolicy;
  fetchAllow?: string[];
  limits?: Partial<EngineLimits>;
};

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}

export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_EFFORT: Effort = "high";

/** Built-in price table used when a provider reports tokens but not USD. */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { inputPer1M: 5, outputPer1M: 25 },
  "claude-sonnet-5": { inputPer1M: 3, outputPer1M: 15 },
  "claude-haiku-4-5": { inputPer1M: 1, outputPer1M: 5 },
};

export function resolveConfig(input: EngineConfigInput = {}): EngineConfig {
  return {
    defaults: {
      provider: input.defaults?.provider ?? "claude",
      model: input.defaults?.model ?? DEFAULT_MODEL,
      effort: input.defaults?.effort ?? DEFAULT_EFFORT,
    },
    providers: input.providers ?? {},
    approvalPolicy: input.approvalPolicy ?? {},
    ...(input.fetchAllow ? { fetchAllow: input.fetchAllow } : {}),
    limits: {
      concurrency: input.limits?.concurrency ?? defaultConcurrency(),
      maxTurns: input.limits?.maxTurns ?? 50,
      stepTimeoutMs: input.limits?.stepTimeoutMs ?? 20 * 60_000,
      execTimeoutMs: input.limits?.execTimeoutMs ?? 10 * 60_000,
      fetchTimeoutMs: input.limits?.fetchTimeoutMs ?? 60_000,
      repair: input.limits?.repair ?? 2,
      agentGuideline: input.limits?.agentGuideline ?? 15,
      agentHard: input.limits?.agentHard ?? 1000,
      fanoutMax: input.limits?.fanoutMax ?? 4096,
      blobThresholdBytes: input.limits?.blobThresholdBytes ?? 64 * 1024,
      maxDepth: input.limits?.maxDepth ?? 3,
    },
  };
}

export function priceFor(
  config: EngineConfig,
  providerId: string,
  model: string | undefined,
): ModelPrice | undefined {
  if (!model) return undefined;
  return config.providers[providerId]?.prices?.[model] ?? DEFAULT_PRICES[model];
}
