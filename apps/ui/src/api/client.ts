/**
 * The daemon, as functions.
 *
 * One place that knows the URLs, the query flags and what a failure looks like, so no
 * component ever holds a path string. Everything is same-origin: the manager is served by
 * the daemon it talks to, which is also what keeps it inside the loopback guard — a
 * cross-origin base URL would be refused, and correctly so.
 */
import type {
  ArtifactEntry,
  ConfigResponse,
  Meta,
  PatchResponse,
  PendingResponse,
  RunDetail,
  RunRow,
  WeftConfigFile,
  WorkflowDetail,
  WorkflowIssue,
  WorkflowRow,
  WorkflowStats,
  WorkflowTask,
} from "./types";

/**
 * A failed request, carrying the daemon's own message. The engine's errors are the useful
 * part of a 400 — "workflow gate: no-date-now at review.ts:2" is the answer, not noise to
 * be replaced with "Bad Request".
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the thing asked for is not there, as opposed to the asking being wrong. */
  get missing(): boolean {
    return this.status === 404;
  }

  /** True when nothing answered — the daemon is down, or a proxy could not reach it. */
  get unreachable(): boolean {
    return this.status === 0 || GATEWAY.has(this.status);
  }
}

/**
 * Statuses that mean "no one answered", not "your request was wrong".
 *
 * The daemon serves this page itself in production, so it never emits these — they come
 * from whatever is in front of it. In dev that is the Vite proxy, which returns a bare
 * `502 Bad Gateway` in `text/plain` when the daemon is not running. Parsing that as the
 * daemon's own error shape yields nothing, and the UI would show the literal words
 * "502 Bad Gateway" — a status where the actionable fact belongs.
 */
const GATEWAY = new Set([502, 503, 504]);

const UNREACHABLE = "cannot reach the daemon — is `weft ui` still running?";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    // A dead socket is the daemon being gone, which is worth saying plainly: every other
    // failure here arrives as a status code with a message attached.
    throw new ApiError(0, `${UNREACHABLE} (${String(err)})`);
  }
  if (!res.ok) {
    if (GATEWAY.has(res.status)) throw new ApiError(res.status, UNREACHABLE);
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof body?.error === "string" ? body.error : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  meta: () => request<Meta>("/api/meta"),

  runs: (opts: { spend?: boolean } = {}) => request<RunRow[]>(`/api/runs${opts.spend ? "?spend=1" : ""}`),

  /** `detail` adds the run's budget ceiling and each step's input. */
  run: (runId: string, opts: { detail?: boolean } = {}) =>
    request<RunDetail>(`/api/runs/${encodeURIComponent(runId)}${opts.detail ? "?detail=1" : ""}`),

  pending: () => request<PendingResponse>("/api/pending"),

  workflows: () => request<WorkflowRow[]>("/api/workflows"),
  workflowIssues: () => request<WorkflowIssue[]>("/api/workflows/issues"),
  workflow: (name: string) => request<WorkflowDetail>(`/api/workflows/${encodeURIComponent(name)}`),
  workflowStats: (name: string) => request<WorkflowStats>(`/api/workflows/${encodeURIComponent(name)}/stats`),
  workflowTasks: (name: string) =>
    request<WorkflowTask[]>(`/api/workflows/${encodeURIComponent(name)}/tasks`),

  artifacts: (runId: string) => request<ArtifactEntry[]>(`/api/runs/${encodeURIComponent(runId)}/artifacts`),

  /** `stats` omits the diff text, which is the larger half and only needed per file. */
  patch: (runId: string, opts: { statsOnly?: boolean } = {}) =>
    request<PatchResponse>(`/api/runs/${encodeURIComponent(runId)}/patch${opts.statsOnly ? "?stats=1" : ""}`),

  config: () => request<ConfigResponse>("/api/config"),

  /** The body IS the file: a settings screen holds the whole object. */
  saveConfig: (config: WeftConfigFile) =>
    request<{ ok: true; path: string; restartRequired: boolean }>("/api/config", {
      method: "PUT",
      body: JSON.stringify(config),
    }),

  start: (body: { workflow: string; input?: unknown; budget?: string; reuse?: "content" | "key" }) =>
    request<{ ok: true; runId: string; workflow: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  answer: (
    runId: string,
    requestId: string,
    answer: unknown,
    reviewEdit?: { content: string; beforeSha256: string },
  ) =>
    request<{ ok: true; woke: boolean }>(`/api/runs/${encodeURIComponent(runId)}/answer`, {
      method: "POST",
      body: JSON.stringify({ requestId, answer, ...(reviewEdit !== undefined ? { reviewEdit } : {}) }),
    }),

  cancel: (runId: string) =>
    request<{ ok: true }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),

  resume: (runId: string) =>
    request<{ ok: true; runId: string }>(`/api/runs/${encodeURIComponent(runId)}/resume`, {
      method: "POST",
    }),

  /** The URL for a blob's bytes — handed to an <img>/<a>, not fetched here. */
  blobUrl: (ref: string, as?: "text" | "json") =>
    `/api/blobs/${encodeURIComponent(ref)}${as ? `?as=${as}` : ""}`,

  blobText: (ref: string) =>
    fetch(`/api/blobs/${encodeURIComponent(ref)}?as=text`).then((res) => {
      if (GATEWAY.has(res.status)) throw new ApiError(res.status, UNREACHABLE);
      if (!res.ok) throw new ApiError(res.status, `blob ${ref} is not readable`);
      return res.text();
    }),

  blobJson: (ref: string) =>
    fetch(`/api/blobs/${encodeURIComponent(ref)}?as=json`).then(async (res) => {
      if (GATEWAY.has(res.status)) throw new ApiError(res.status, UNREACHABLE);
      if (!res.ok) throw new ApiError(res.status, `blob ${ref} is not readable`);
      return (await res.json()) as unknown;
    }),

  presentationFrameUrl: (runId: string, presentationId: string) =>
    `/api/runs/${encodeURIComponent(runId)}/presentations/${encodeURIComponent(presentationId)}/frame`,
};
