import { readFile } from "node:fs/promises";
import { type JournalEvent, type JournalRecord, ReplayIndex, reduceState } from "@techery/weft-core";
import { describe, expect, test } from "vitest";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/history/7fe75e9.json", import.meta.url), "utf8"),
) as {
  sourceCommit: string;
  construction: string;
  cases: Array<{ id: string; events: JournalEvent[]; projection: unknown; replay: unknown }>;
};

describe("frozen 7fe75e9 event-contract compatibility", () => {
  test("retains explicit fixture provenance", () => {
    expect(fixture.sourceCommit).toBe("7fe75e96a9de66143005d392ce6d554b7b98de1e");
    expect(fixture.construction).toContain("not captured production runs");
  });

  for (const vector of fixture.cases) {
    test(vector.id, () => {
      const records: JournalRecord[] = vector.events.map((ev, i) => ({ i, at: 1_700_000_000_000 + i, ev }));
      const state = reduceState(records);
      expect({
        status: state.status,
        output: state.output ?? null,
        errorCode: state.error?.code ?? null,
        checks: state.checks,
        humans: state.humans.map(({ key, status, answer }) => ({ key, status, answer: answer ?? null })),
        budget: state.budget,
      }).toEqual(vector.projection);
      const replay = ReplayIndex.fromRecords(records);
      expect({
        completed: replay.bySeq.size,
        tokens: replay.totalUsage.tokens,
        usd: replay.totalUsage.usd,
        pendingHumans: [...replay.humansById.values()].filter((human) => human.answer === undefined).length,
      }).toEqual(vector.replay);
      for (const entry of replay.bySeq.values()) {
        const reused = replay.matchStep(100 + entry.seq, entry.hash, entry.kind, entry.key, "content", false);
        expect(reused?.entry.output).toEqual(entry.output);
        expect(reused?.via).toBe("salvage");
      }
      expect(state.operations ?? []).toEqual([]);
      expect(state.deliveries ?? []).toEqual([]);
    });
  }
});
