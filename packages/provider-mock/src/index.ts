/**
 * @techery/weft-provider-mock — a scripted AgentProvider for tests and replay
 * verification. Fixtures match on the step's key (globs), receive the real
 * request, and their outputs go through the engine's normal schema validation —
 * a fixture that wouldn't pass in production fails the test.
 */
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  AgentProvider,
  AgentRequest,
  AgentResult,
  AgentTaskOperation,
  ProviderCapabilities,
  RunControl,
} from "@techery/weft-core";
import type { SchemaIssue, Usage } from "@techery/weft-sdk";
import picomatch from "picomatch";

const MOCK_ENVELOPE = Symbol("weft.mock.taskEnvelope");

export interface MockTaskEnvelope {
  readonly [MOCK_ENVELOPE]: true;
  result: unknown;
  taskOperations: AgentTaskOperation[];
}

/** Explicitly model the structured task envelope a real provider returns. */
export function mockTaskEnvelope(result: unknown, taskOperations: AgentTaskOperation[]): MockTaskEnvelope {
  return { [MOCK_ENVELOPE]: true, result, taskOperations };
}

/**
 * Fixture globs are plain string patterns, not path patterns: `*` matches ANY
 * characters including `/`, so `review:*` matches `review:src/auth/login.ts`.
 */
function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

export interface MockRequest {
  prompt: string;
  key?: string;
  label: string;
  cwd: string;
  schema: unknown;
  model?: string;
  effort?: string;
  tools: AgentRequest["tools"];
  providerOptions?: unknown;
  writeScope?: { paths: string[]; also?: string[]; mode: "warn" | "strict" };
  protectedPaths?: readonly string[];
  /** 1 on the first call; >1 on repair calls, with the validation issues. */
  attempt: number;
  issues?: SchemaIssue[];
}

export type MockResponder =
  | ((req: MockRequest) => unknown | Promise<unknown>)
  | MockTaskEnvelope
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

export interface MockRuleOptions {
  usage?: Partial<Usage>;
  /** Files written into the request cwd before responding (write-step fixtures). */
  writes?: Record<string, string>;
  /**
   * What the provider reports it touched. Defaults to the `writes` keys. Set it
   * explicitly to model a path capture cannot see — an absolute one, or a `../` escape.
   */
  filesTouched?: string[];
  delayMs?: number;
  /** Consume the rule after N matches (default: unlimited). */
  times?: number;
}

export interface MockOptions {
  /** Provider behavior advertised to capability preflight. Defaults to the permissive mock profile. */
  profile?: "mock" | "claude" | "codex";
  /** Enforce edit and protected-path policy before applying fixture writes. */
  strict?: boolean;
}

interface MockRule {
  match: { key?: string; prompt?: string | RegExp; label?: string };
  respond: MockResponder;
  opts: MockRuleOptions;
  used: number;
}

export class MockAgentBuilder {
  readonly rules: MockRule[] = [];
  readonly calls: MockRequest[] = [];

  constructor(readonly options: MockOptions = {}) {}

  on(match: MockRule["match"], respond: MockResponder, opts: MockRuleOptions = {}): this {
    this.rules.push({ match, respond, opts, used: 0 });
    return this;
  }

  /** Build a provider with the given id sharing this builder's rules and call log. */
  provider(id: string): MockProvider {
    return new MockProvider(id, this);
  }
}

/** Fluent entry point: `mock().on({ key: "review:*" }, () => ({ … }))`. */
export function mock(options: MockOptions = {}): MockAgentBuilder {
  return new MockAgentBuilder(options);
}

/** A stateful responder for repeated matches. Arrays remain ordinary fixture outputs. */
export function mockSequence(values: readonly MockResponder[]): MockResponder {
  if (values.length === 0) throw new TypeError("mockSequence: provide at least one response");
  let index = 0;
  return async (request) => {
    if (index >= values.length) {
      throw new Error(
        `mockSequence: exhausted after ${values.length} response(s) for ${request.key ?? request.label}`,
      );
    }
    const value = values[index++];
    return typeof value === "function" ? await value(request) : value;
  };
}

export class MockProvider implements AgentProvider {
  private sessions = new Map<string, AgentRequest>();
  private sessionCounter = 0;

  constructor(
    readonly id: string,
    readonly builder: MockAgentBuilder,
  ) {}

  capabilities(): ProviderCapabilities {
    if (this.builder.options.profile === "codex") {
      return { structured: "native", permissionHook: false, sessionResume: true, reportsUsd: false };
    }
    return { structured: "tool", permissionHook: true, sessionResume: true, reportsUsd: true };
  }

  private findRule(req: AgentRequest, forRepair: boolean): MockRule {
    const rule = this.builder.rules.find((r) => {
      if (r.opts.times !== undefined && r.used >= r.opts.times) return false;
      if (r.match.key !== undefined) {
        if (req.key === undefined || !globMatch(req.key, r.match.key)) return false;
      }
      if (r.match.label !== undefined && !globMatch(req.label, r.match.label)) return false;
      if (r.match.prompt !== undefined) {
        if (typeof r.match.prompt === "string") {
          if (!req.prompt.includes(r.match.prompt)) return false;
        } else if (!r.match.prompt.test(req.prompt)) return false;
      }
      return true;
    });
    if (!rule) {
      const known = this.builder.rules
        .map((r) =>
          JSON.stringify({
            ...r.match,
            prompt: r.match.prompt instanceof RegExp ? String(r.match.prompt) : r.match.prompt,
          }),
        )
        .join(", ");
      throw new Error(
        `mock provider "${this.id}": no fixture matches ${forRepair ? "repair of " : ""}step ` +
          `key=${req.key ?? "(none)"} label=${req.label} (rules: ${known || "none"})`,
      );
    }
    return rule;
  }

  private async respond(
    req: AgentRequest,
    attempt: number,
    issues?: SchemaIssue[],
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const rule = this.findRule(req, attempt > 1);
    rule.used++;
    const mockReq: MockRequest = {
      prompt: req.prompt,
      label: req.label,
      cwd: req.cwd,
      schema: req.schema,
      attempt,
      tools: req.tools,
      ...(req.key !== undefined ? { key: req.key } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.effort !== undefined ? { effort: req.effort } : {}),
      ...(req.providerOptions !== undefined ? { providerOptions: req.providerOptions } : {}),
      ...(req.writeScope !== undefined ? { writeScope: req.writeScope } : {}),
      ...(req.protectedPaths !== undefined ? { protectedPaths: req.protectedPaths } : {}),
      ...(issues !== undefined ? { issues } : {}),
    };
    this.builder.calls.push(mockReq);
    if (rule.opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, rule.opts.delayMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    }
    const writes = Object.entries(rule.opts.writes ?? {});
    if (this.builder.options.strict && writes.length > 0 && req.tools.allowEdits !== true) {
      throw new Error(`mock provider "${this.id}": fixture attempted writes in a read-only step`);
    }
    if (this.builder.options.strict) {
      const touched = new Set([...writes.map(([path]) => path), ...(rule.opts.filesTouched ?? [])]);
      const allowed = req.writeScope
        ? picomatch([...req.writeScope.paths, ...(req.writeScope.also ?? [])], { dot: true })
        : undefined;
      for (const path of touched) {
        const target = resolve(req.cwd, path);
        const relPath = relative(req.cwd, target).replaceAll("\\", "/");
        const escaped = isAbsolute(path) || relPath === ".." || relPath.startsWith("../");
        if (escaped) {
          throw new Error(`mock provider "${this.id}": fixture write escapes the workspace: ${path}`);
        }
        if (allowed !== undefined && !allowed(relPath)) {
          throw new Error(`mock provider "${this.id}": fixture write is outside the declared scope: ${path}`);
        }
        const protectedPath = req.protectedPaths?.find((candidate) => {
          const rel = relative(candidate, target);
          return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
        });
        if (protectedPath !== undefined) {
          throw new Error(`mock provider "${this.id}": fixture write targets protected path ${path}`);
        }
      }
    }
    for (const [path, content] of writes) {
      const target = resolve(req.cwd, path);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    const fixtureOutput =
      typeof rule.respond === "function"
        ? await (rule.respond as (r: MockRequest) => unknown)(mockReq)
        : rule.respond;
    const explicitEnvelope =
      typeof fixtureOutput === "object" &&
      fixtureOutput !== null &&
      MOCK_ENVELOPE in fixtureOutput &&
      (fixtureOutput as MockTaskEnvelope)[MOCK_ENVELOPE] === true;
    // Host-backed engines use the same structured envelope real providers see.
    // Existing fixtures describe the workflow result, so wrap them automatically;
    // a fixture that explicitly returns an envelope can exercise task operations.
    const output =
      req.taskContext !== undefined
        ? explicitEnvelope
          ? {
              result: (fixtureOutput as MockTaskEnvelope).result,
              taskOperations: (fixtureOutput as MockTaskEnvelope).taskOperations,
            }
          : { result: fixtureOutput, taskOperations: [] }
        : fixtureOutput;
    const sessionId = `mock-${this.id}-${++this.sessionCounter}`;
    this.sessions.set(sessionId, req);
    const filesTouched = rule.opts.filesTouched ?? Object.keys(rule.opts.writes ?? {});
    return {
      output,
      usage: { input: 100, output: 50, ...rule.opts.usage },
      ...(filesTouched.length > 0 ? { filesTouched } : {}),
      sessionId,
      transcript: `mock transcript for ${req.key ?? req.label}\nprompt: ${req.prompt.slice(0, 500)}`,
    };
  }

  async run(req: AgentRequest, ctl: RunControl): Promise<AgentResult> {
    return this.respond(req, 1, undefined, ctl.signal);
  }

  async repair(
    sessionId: string | undefined,
    req: AgentRequest,
    errors: SchemaIssue[],
    ctl: RunControl,
  ): Promise<AgentResult> {
    const original = sessionId ? (this.sessions.get(sessionId) ?? req) : req;
    const attempt = 2 + this.builder.calls.filter((c) => c.key === req.key && c.attempt >= 2).length;
    return this.respond(original, attempt, errors, ctl.signal);
  }
}
