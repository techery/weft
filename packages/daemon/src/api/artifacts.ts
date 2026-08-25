/**
 * `GET /api/runs/:id/artifacts` and `GET /api/runs/:id/patch` — the files a run produced.
 *
 * A run's journal records artifacts and captured patches as refs, and the projection
 * carries those refs through, but nothing ever answered the two questions a reader
 * actually has: *what* did this run write, and *what changed*. The inventory answers the
 * first; the patch route answers the second, and parses the unified diff so a file tree
 * can show `+42 −7` without the caller re-implementing diff arithmetic.
 *
 * Neither route returns bytes for an artifact — `GET /api/blobs/:ref` does, and it is
 * cacheable forever because the ref is the hash. The patch is the exception: its text is
 * what the route is for, and it is small.
 */
import type { RunState, Weft } from "@techery/weft-host";
import type { Hono } from "hono";
import { fail } from "../http.ts";
import { stateOf } from "../state.ts";

export interface FileStat {
  path: string;
  adds: number;
  dels: number;
  /** `added` / `deleted` / `modified`, and `binary` when git reported no line changes. */
  status: "added" | "deleted" | "modified" | "binary";
}

export function registerArtifactRoutes(app: Hono, weft: Weft): void {
  app.get("/api/runs/:id/artifacts", async (c) => {
    try {
      const state = await stateOf(weft, c.req.param("id"));
      const entries = inventory(state);
      // A blob can be pruned while its ref stays in the journal, so say which are readable
      // rather than letting a viewer discover it as a 404 per file.
      const present = await Promise.all(entries.map((e) => weft.engine.blobs.has(e.ref).catch(() => false)));
      return c.json(entries.map((entry, i) => ({ ...entry, available: present[i] === true })));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/runs/:id/patch", async (c) => {
    try {
      const state = await stateOf(weft, c.req.param("id"));
      const key = c.req.query("key");
      const wanted =
        key === undefined ? state.patches.captured : state.patches.captured.filter((p) => p.key === key);
      if (key !== undefined && wanted.length === 0)
        throw new Error(`patch ${key} not found in run ${state.runId}`);

      // `?stats=1` renders a file tree without moving the diff text, which is the larger
      // half of the payload and is only needed for the file actually being looked at.
      const statsOnly = c.req.query("stats") === "1";

      const patches = await Promise.all(
        wanted.map(async (patch) => {
          const diff = await weft.engine.blobs.getText(patch.ref).catch(() => undefined);
          return {
            key: patch.key,
            ref: patch.ref,
            // The journal's own file list, which is authoritative for scope decisions.
            files: patch.files,
            outOfScope: patch.outOfScope ?? [],
            // By key, not by ref: merge and discard act on a key, and blobs are
            // content-addressed — two candidate patches with identical diffs share one
            // ref, so matching on it reports an untouched candidate as already landed.
            merged: state.patches.merged.some((m) => m.key === patch.key),
            discarded: state.patches.discarded.some((d) => d.key === patch.key),
            available: diff !== undefined,
            stats: diff === undefined ? [] : parseDiffStats(diff),
            ...(statsOnly || diff === undefined ? {} : { diff }),
          };
        }),
      );
      return c.json({ runId: state.runId, patches });
    } catch (err) {
      return fail(c, err);
    }
  });
}

interface Artifact {
  ref: string;
  /** Stable identity within a run: the patch key, or the gate id for an attachment. */
  id: string;
  kind: "patch" | "artifact";
  size: number | null;
  /** Which step or gate produced it, when the projection records the link. */
  producedBy: { seq: number; kind: string; label: string } | null;
  at: number | null;
  key?: string;
  files?: string[];
  preview?: string;
  /** Present for a gate attachment: which question it was shown with. */
  gate?: { id: string; kind: string; question: string };
}

/**
 * Everything the projection knows a ref for, de-duplicated by ref. Captured patches come
 * first because they are the ones a reader opens; a gate's attached artifact follows.
 */
function inventory(state: RunState): Artifact[] {
  const out = new Map<string, Artifact>();

  for (const patch of state.patches.captured) {
    // Keyed by patch key, not by ref: two candidate patches with byte-identical diffs
    // share one content-addressed ref, and keying by it drops one of them from the run's
    // artifact list entirely.
    const step = state.steps.find((s) => s.patchRef === patch.ref);
    out.set(`patch:${patch.key}`, {
      ref: patch.ref,
      id: patch.key,
      kind: "patch",
      size: null,
      // The step object already in hand, never a second lookup by seq: a resumed run
      // whose definition changed journals two different steps at the same seq, and a
      // seq-keyed map keeps only the later one — attributing a patch to whatever the
      // second pass happened to schedule in that position.
      producedBy: step
        ? { seq: step.seq, kind: step.kind, label: step.label ?? step.key ?? `${step.kind}#${step.seq}` }
        : null,
      at: step?.endedAt ?? step?.startedAt ?? null,
      key: patch.key,
      files: patch.files,
    });
  }

  for (const human of state.humans) {
    const ref = human.artifactRef;
    if (ref === undefined) continue;
    out.set(`gate:${human.id}`, {
      ref: ref.$blob,
      id: human.id,
      kind: "artifact",
      size: ref.size,
      // A gate is not a step. Looking its seq up in the step table can only match by
      // coincidence, and a coincidence here is a wrong attribution rather than a missing
      // one — so the gate names itself and `producedBy` stays honest.
      producedBy: null,
      gate: { id: human.id, kind: human.kind, question: human.question },
      at: human.requestedAt,
      ...(ref.preview !== undefined ? { preview: ref.preview } : {}),
    });
  }

  return [...out.values()];
}

/**
 * Per-file added/removed line counts from a unified diff — what `git diff --cached`
 * writes, which is exactly what `capturePatch` stores.
 *
 * Three things make this more than a line count.
 *
 * `---` and `+++` are file headers only BEFORE the first `@@` of a file. Inside a hunk
 * every line is content, and content that happens to start with `-- ` or `++ ` (a SQL or
 * Lua comment, a diff of a diff, a markdown rule) renders as `--- …` / `+++ …`. Treating
 * those as headers both loses the line from the count and overwrites the file's path with
 * the line's own text, so the UI shows a file that does not exist.
 *
 * The `a/`/`b/` prefixes are not guaranteed. `capturePatch` pins neither
 * `--default-prefix` nor `--src-prefix`, so a user or repo `diff.mnemonicPrefix` turns
 * them into `c/` and `i/` and every reported path is wrong. The prefix is taken from the
 * `diff --git` line's own pair instead of assumed.
 *
 * And a path git considers unusual arrives C-quoted — `"b/caf\303\251.ts"` — because the
 * patch text is produced without `core.quotePath=false`. Quoted paths are unescaped, so
 * they match the journal's own `files` list (captured with `-z`, which never quotes) and
 * the file tree can actually join the two.
 */
export function parseDiffStats(diff: string): FileStat[] {
  const out: FileStat[] = [];
  let current: FileStat | undefined;
  let inHunk = false;

  for (const rawLine of diff.split("\n")) {
    // CRLF patches would otherwise leave a \r on every path and every counted line.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      current = { path: pathOfHeader(line), adds: 0, dels: 0, status: "modified" };
      out.push(current);
      inHunk = false;
      continue;
    }
    if (current === undefined) continue;

    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }

    if (inHunk) {
      // Everything from here to the next file is content. `\ No newline at end of file`
      // is a marker, not a line, and starts with a backslash so it is skipped naturally.
      if (line.startsWith("+")) current.adds++;
      else if (line.startsWith("-")) current.dels++;
      continue;
    }

    // Pre-hunk: the header block.
    if (line.startsWith("--- ")) {
      if (line.slice(4).trim() === "/dev/null") current.status = "added";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") current.status = "deleted";
      // The `+++` header is the authoritative path: it survives a filename with spaces,
      // which the `diff --git a/x b/x` line cannot be split on reliably.
      else current.path = stripPrefix(unquotePath(target)) || current.path;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.status = "binary";
    }
  }
  return out;
}

/**
 * `diff --git a/src/x.ts b/src/x.ts` → `src/x.ts`, whatever the prefixes are.
 *
 * Two paths with one space between them and no way to tell which space is the separator
 * when either contains one — so the halving guess stands only as the entry's starting
 * name. The `+++` header corrects it a line or two later, and for the deletion case
 * (`+++ /dev/null`) the `a/` side read here is the only name there is.
 */
function pathOfHeader(line: string): string {
  const rest = line.slice("diff --git ".length).trim();
  if (rest.startsWith('"')) {
    // A quoted first path ends at its closing quote, unambiguously.
    const closing = findClosingQuote(rest);
    if (closing > 0) return stripPrefix(unquotePath(rest.slice(0, closing + 1)));
  }
  const half = Math.floor(rest.length / 2);
  return stripPrefix(rest.slice(0, half).trim()) || rest;
}

/**
 * Drop git's diff prefix, whatever it is. `a/`/`b/` by default, `c/`/`i/`/`w/` under
 * `diff.mnemonicPrefix`, anything at all under `diff.srcPrefix`/`dstPrefix` — so any
 * single leading path segment of one or two characters is treated as the prefix, and a
 * real first directory is only ever that short by coincidence.
 */
function stripPrefix(path: string): string {
  const slash = path.indexOf("/");
  if (slash === 1 || slash === 2) return path.slice(slash + 1);
  return path;
}

/**
 * Undo git's C-style quoting. A path outside plain ASCII, or holding a quote, backslash or
 * control character, is emitted wrapped in double quotes with octal escapes for each byte
 * — and those bytes are UTF-8, so they are collected and decoded together rather than one
 * at a time.
 */
function unquotePath(path: string): string {
  if (!path.startsWith('"')) return path;
  const closing = findClosingQuote(path);
  const body = path.slice(1, closing > 0 ? closing : undefined);

  const bytes: number[] = [];
  const push = (text: string) => {
    for (const byte of new TextEncoder().encode(text)) bytes.push(byte);
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      push(ch ?? "");
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      i += 1;
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    // An escape git does not produce: keep the character it guarded.
    push(next);
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const SIMPLE_ESCAPES: Record<string, number> = {
  '"': 0x22,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

/** Index of the quote that closes the one at position 0, skipping escaped quotes. */
function findClosingQuote(text: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === '"') return i;
  }
  return -1;
}
