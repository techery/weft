# 04 · Resume & edit-tolerant replay

Resume is re-execution with the answers already known (C3/C4): completed steps are
served from the journal, edits re-run only what they touched, and `replay --dry` shows
the plan before any model is called.

```sh
npx tsx examples/04-resume-and-replay/main.ts
```

The run suspends on a human gate after three agent steps, then:

- **unchanged resume** — zero provider calls; the journaled `ctx.random()` draw comes
  back bit-identical;
- **`replayDry` with an edited script** — reports `hits=1 diverged=[analyze]` without
  touching a provider (the two steps *after* the reword would re-run in a real resume
  only if their inputs changed; here `scan` hits and `summarize` salvages);
- **real resume of the edit** — exactly **one** provider call (the reworded `analyze`),
  everything else served, and the random draw still identical.
