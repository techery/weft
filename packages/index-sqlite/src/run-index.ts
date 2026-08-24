import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JournalRecord, JournalStore, RunStatus, RunSummary, StepState } from "@weft/core";
import { reduceState } from "@weft/core";

/**
 * Bump to invalidate every local index. The rows are a fold over journals, so a
 * mismatched database is dropped and rebuilt rather than migrated.
 */
export const SCHEMA_VERSION = 1;

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
    search_text   TEXT NOT NULL
  )
`;

const UPSERT = `
  INSERT INTO runs
    (run_id, workflow, status, created_at, updated_at, parent_run_id, agent_steps, tokens, usd, search_text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id) DO UPDATE SET
    workflow      = excluded.workflow,
    status        = excluded.status,
    created_at    = excluded.created_at,
    updated_at    = excluded.updated_at,
    parent_run_id = excluded.parent_run_id,
    agent_steps   = excluded.agent_steps,
    tokens        = excluded.tokens,
    usd           = excluded.usd,
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
    this.db = new DatabaseSync(opts.dbPath);
    this.migrate();
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
    // Spend sums ROOT rows only: a parent's workflow-step completion already
    // carries its children's usage (that is how the parent budget restores), so
    // adding the child rows would count every sub-workflow's spend twice.
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS runs, " +
          "COALESCE(SUM(CASE WHEN parent_run_id IS NULL THEN tokens ELSE 0 END), 0) AS tokens, " +
          "COALESCE(SUM(CASE WHEN parent_run_id IS NULL THEN usd ELSE 0 END), 0) AS usd " +
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
  searchText: string;
}

function summarize(runId: string, records: JournalRecord[]): IndexRow | undefined {
  if (records.length === 0) return undefined;
  const state = reduceState(records);
  const { tokens, usd } = spendOf(records, state.steps);
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
