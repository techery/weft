import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JournalRecord, JournalStore, RunStatus, RunSummary, StepState } from "@techery/weft-core";
import { reduceState } from "@techery/weft-core";

/**
 * Bump to invalidate every local index. The rows are a fold over journals, so a
 * mismatched database is dropped and rebuilt rather than migrated.
 */
export const SCHEMA_VERSION = 2;

/** Default cap on `search()`; the index exists to make `ls` fast, not to page. */
export const DEFAULT_SEARCH_LIMIT = 50;

/** A `RunSummary` plus the counters the index keeps so a list view needs no journal reads. */
export interface IndexedRun extends RunSummary {
  agentSteps: number;
  tokens: number;
  usd: number;
}

export interface RunSearchQuery {
  /** Case-insensitive substring over the workflow name, step keys/labels, and human questions. */
  text?: string;
  status?: string;
  workflow?: string;
  limit?: number;
}

export interface RunIndexStats {
  runs: number;
  tokens: number;
  usd: number;
}

export interface RunIndexOptions {
  /** File path for the index; `":memory:"` keeps it process-local. */
  dbPath: string;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id        TEXT PRIMARY KEY,
    workflow      TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    parent_run_id TEXT,
    agent_steps   INTEGER NOT NULL,
    tokens        INTEGER NOT NULL,
    usd           REAL NOT NULL,
    own_tokens    INTEGER NOT NULL,
    own_usd       REAL NOT NULL,
    search_text   TEXT NOT NULL
  )
`;

const UPSERT = `
  INSERT INTO runs
    (run_id, workflow, status, created_at, updated_at, parent_run_id, agent_steps, tokens, usd,
     own_tokens, own_usd, search_text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id) DO UPDATE SET
    workflow      = excluded.workflow,
    status        = excluded.status,
    created_at    = excluded.created_at,
    updated_at    = excluded.updated_at,
    parent_run_id = excluded.parent_run_id,
    agent_steps   = excluded.agent_steps,
    tokens        = excluded.tokens,
    usd           = excluded.usd,
    own_tokens    = excluded.own_tokens,
    own_usd       = excluded.own_usd,
    search_text   = excluded.search_text
`;

const SELECT_COLUMNS =
  "run_id, workflow, status, created_at, updated_at, parent_run_id, agent_steps, tokens, usd";

/**
 * A derived, rebuildable index over local runs: one row per run, folded from its
 * journal. Nothing here is a source of truth — delete the file and `rebuild()`
 * restores it — which is what makes dropping the table on a version mismatch safe.
 */
export class RunIndex {
  private readonly db: DatabaseSync;

  constructor(opts: RunIndexOptions) {
    if (opts.dbPath !== ":memory:") mkdirSync(dirname(opts.dbPath), { recursive: true });
    try {
      this.db = new DatabaseSync(opts.dbPath);
      this.migrate();
    } catch (err) {
      // Nothing here is a source of truth — every row is a fold over a journal — so
      // discarding a CORRUPT file is safe, and refusing to open is not: it takes
      // `weft ls` down with it and there is no other repair path.
      //
      // Corruption only. A lock contention (SQLITE_BUSY / SQLITE_LOCKED) or a transient
      // I/O or permission failure means the database is fine and someone else is using
      // it; deleting it there would destroy a healthy index, and its WAL and SHM out
      // from under a live connection. Those propagate. An in-memory database has nothing
      // to delete either way.
      if (opts.dbPath === ":memory:" || !isCorruption(err)) throw err;
      rmSync(opts.dbPath, { force: true });
      // SQLite's sidecars belong to the file just discarded.
      rmSync(`${opts.dbPath}-wal`, { force: true });
      rmSync(`${opts.dbPath}-shm`, { force: true });
      this.db = new DatabaseSync(opts.dbPath);
      this.migrate();
    }
  }

  /** Drop-and-recreate on any version drift; derived data is never migrated. */
  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get();
    if (numberOf(row?.["user_version"]) !== SCHEMA_VERSION) {
      this.db.exec("DROP TABLE IF EXISTS runs");
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    this.db.exec(CREATE_TABLE);
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_created_at ON runs (created_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_status ON runs (status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_workflow ON runs (workflow)");
  }

  /** Upsert one run from its journal records. An empty journal indexes nothing. */
  indexRun(runId: string, records: JournalRecord[]): void {
    const row = summarize(runId, records);
    if (!row) return;
    this.db
      .prepare(UPSERT)
      .run(
        row.runId,
        row.workflow,
        row.status,
        row.createdAt,
        row.updatedAt,
        row.parentRunId ?? null,
        row.agentSteps,
        row.tokens,
        row.usd,
        row.ownTokens,
        row.ownUsd,
        row.searchText,
      );
  }

  /** Wipe and re-index every run the store knows about. Safe to run at any time. */
  async rebuild(store: JournalStore): Promise<void> {
    const summaries = await store.list();
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM runs");
      for (const summary of summaries) {
        const records: JournalRecord[] = [];
        for await (const rec of store.read(summary.runId)) records.push(rec);
        this.indexRun(summary.runId, records);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Newest first. `text` is a LIKE over the searchable column, not a ranked query. */
  search(q: RunSearchQuery = {}): IndexedRun[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q.text !== undefined && q.text !== "") {
      where.push("search_text LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(q.text.toLowerCase())}%`);
    }
    if (q.status !== undefined) {
      where.push("status = ?");
      params.push(q.status);
    }
    if (q.workflow !== undefined) {
      where.push("workflow = ?");
      params.push(q.workflow);
    }
    const sql = [
      `SELECT ${SELECT_COLUMNS} FROM runs`,
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY created_at DESC, run_id ASC",
      "LIMIT ?",
    ]
      .filter((part) => part !== "")
      .join(" ");
    params.push(Math.max(0, q.limit ?? DEFAULT_SEARCH_LIMIT));
    return this.db
      .prepare(sql)
      .all(...params)
      .map(toIndexedRun);
  }

  /** Totals across the whole index — what `weft ls` prints at the bottom. */
  stats(): RunIndexStats {
    // Spend sums each run's OWN (non-roll-up) usage across EVERY row: a token
    // counts exactly once, at the run that spent it. Summing display tokens
    // would double-count children through their parents' workflow-step
    // roll-ups, and summing roots only would LOSE child spend no completed
    // parent step ever rolled up (a failed child, a parent stopped mid-child).
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS runs, " +
          "COALESCE(SUM(own_tokens), 0) AS tokens, " +
          "COALESCE(SUM(own_usd), 0) AS usd " +
          "FROM runs",
      )
      .get();
    return {
      runs: numberOf(row?.["runs"]),
      tokens: numberOf(row?.["tokens"]),
      usd: numberOf(row?.["usd"]),
    };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Folding a journal into a row
// ---------------------------------------------------------------------------

interface IndexRow extends IndexedRun {
  ownTokens: number;
  ownUsd: number;
  searchText: string;
}

function summarize(runId: string, records: JournalRecord[]): IndexRow | undefined {
  if (records.length === 0) return undefined;
  const state = reduceState(records);
  const { tokens, usd } = spendOf(records, state.steps);
  const own = ownSpendOf(records);
  const terms = [
    state.workflow,
    ...state.steps.flatMap((s) => [s.key, s.label]),
    ...state.humans.map((h) => h.question),
  ];
  return {
    runId,
    workflow: state.workflow,
    status: state.status,
    createdAt: state.createdAt || records[0]!.at,
    updatedAt: state.updatedAt,
    agentSteps: state.steps.filter((s) => s.kind === "agent").length,
    tokens,
    usd,
    ownTokens: own.tokens,
    ownUsd: own.usd,
    searchText: terms
      .filter((t): t is string => typeof t === "string" && t !== "")
      .join(" ")
      .toLowerCase(),
    ...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
  };
}

/**
 * The engine's own sample wins when it made one (it accounts for restored spend on
 * resume); otherwise fall back to summing per-step usage the way Budget does.
 */
function spendOf(records: JournalRecord[], steps: StepState[]): { tokens: number; usd: number } {
  const sampled = lastBudgetSample(records);
  if (sampled) return sampled;
  let tokens = 0;
  let usd = 0;
  for (const step of steps) {
    if (!step.usage) continue;
    tokens += (step.usage.input ?? 0) + (step.usage.output ?? 0);
    usd += step.usage.usd ?? 0;
  }
  return { tokens, usd };
}

/**
 * Spend the run's OWN steps incurred — workflow-kind roll-ups excluded. A
 * workflow step's usage restates its child run's journal (that is how a parent
 * budget restores); the child row already carries that spend itself.
 */
function ownSpendOf(records: JournalRecord[]): { tokens: number; usd: number } {
  // Sequence numbers RESTART on every resume, so a seq that carried a workflow
  // step in one pass may carry an agent step in the next: classification tracks
  // the LATEST schedule seen in the chronological walk, never a global set.
  const kindBySeq = new Map<number, string>();
  let tokens = 0;
  let usd = 0;
  const fold = (u: { input?: number; output?: number; usd?: number } | undefined, seq: number) => {
    if (!u || kindBySeq.get(seq) === "workflow") return;
    tokens += (u.input ?? 0) + (u.output ?? 0);
    usd += u.usd ?? 0;
  };
  for (const { ev } of records) {
    if (ev.type === "step.scheduled") {
      kindBySeq.set(ev.seq, ev.kind);
    } else if (ev.type === "step.completed" || ev.type === "step.attempt") {
      fold(ev.usage, ev.seq);
    } else if (ev.type === "step.failed") {
      fold(
        (ev.error.detail as { usage?: { input?: number; output?: number; usd?: number } } | undefined)?.usage,
        ev.seq,
      );
    }
  }
  return { tokens, usd };
}

function lastBudgetSample(records: JournalRecord[]): { tokens: number; usd: number } | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const ev = records[i]!.ev;
    if (ev.type === "budget.sampled") return { tokens: ev.tokens, usd: ev.usd };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Row coercion
// ---------------------------------------------------------------------------

function toIndexedRun(row: Record<string, unknown>): IndexedRun {
  const parentRunId = row["parent_run_id"];
  return {
    runId: String(row["run_id"]),
    workflow: String(row["workflow"]),
    status: String(row["status"]) as RunStatus,
    createdAt: numberOf(row["created_at"]),
    updatedAt: numberOf(row["updated_at"]),
    agentSteps: numberOf(row["agent_steps"]),
    tokens: numberOf(row["tokens"]),
    usd: numberOf(row["usd"]),
    ...(typeof parentRunId === "string" ? { parentRunId } : {}),
  };
}

function numberOf(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

/** LIKE wildcards in user text are literal; the statement declares `\` as the escape. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Whether an open/migrate failure means the FILE is unusable, as opposed to busy or
 * briefly unreadable. `node:sqlite` surfaces the sqlite result code on `errcode` where it
 * can; the message check covers builds and paths that do not.
 *
 * SQLITE_NOTADB (26) and SQLITE_CORRUPT (11) are the two that say "this is not a database
 * I can read". Anything else — SQLITE_BUSY, SQLITE_LOCKED, EACCES, EIO — is a condition
 * that passes, and the file must survive it.
 */
export function isCorruption(err: unknown): boolean {
  const code = (err as { errcode?: unknown })?.errcode;
  if (typeof code === "number" && (code === 11 || code === 26)) return true;
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  return message.includes("not a database") || message.includes("malformed") || message.includes("corrupt");
}
