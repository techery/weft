/**
 * @techery/weft-provider-mock — a scripted AgentProvider for tests and replay
 * verification. Fixtures match on the step's key (globs), receive the real
 * request, and their outputs go through the engine's normal schema validation —
 * a fixture that wouldn't pass in production fails the test.
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentProvider,
  AgentRequest,
  AgentResult,
  ProviderCapabilities,
  RunControl,
} from "@techery/weft-core";
import type { SchemaIssue, Usage } from "@techery/weft-sdk";

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
  writeScope?: { paths: string[]; also?: string[]; mode: "warn" | "strict" };
  /** 1 on the first call; >1 on repair calls, with the validation issues. */
  attempt: number;
  issues?: SchemaIssue[];
}

export type MockResponder =
  | ((req: MockRequest) => unknown | Promise<unknown>)
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

interface MockRule {
  match: { key?: string; prompt?: string | RegExp; label?: string };
  respond: MockResponder;
  opts: MockRuleOptions;
  used: number;
}

export class MockAgentBuilder {
  readonly rules: MockRule[] = [];
  readonly calls: MockRequest[] = [];

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
export function mock(): MockAgentBuilder {
  return new MockAgentBuilder();
}

export class MockProvider implements AgentProvider {
  private sessions = new Map<string, AgentRequest>();
  private sessionCounter = 0;

  constructor(
    readonly id: string,
    readonly builder: MockAgentBuilder,
  ) {}

  capabilities(): ProviderCapabilities {
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
      ...(req.key !== undefined ? { key: req.key } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.effort !== undefined ? { effort: req.effort } : {}),
      ...(req.writeScope !== undefined ? { writeScope: req.writeScope } : {}),
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
    for (const [path, content] of Object.entries(rule.opts.writes ?? {})) {
      const target = join(req.cwd, path);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    const output =
      typeof rule.respond === "function"
        ? await (rule.respond as (r: MockRequest) => unknown)(mockReq)
        : rule.respond;
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
