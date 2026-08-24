# 06 · stdlib patterns

`@techery/weft-stdlib` packages the quality patterns — adversarial verification, judge panels,
loop-until-dry discovery, multi-modal sweeps — as plain typed helpers over `ctx`.
Nothing is engine-privileged: a pattern expands into ordinary keyed steps, so it
replays, salvages, and budgets exactly like hand-written workflow code.

```sh
npx tsx examples/06-stdlib-patterns/main.ts
```

The workflow composes three of them:

- **`loopUntilDry`** keeps running discovery rounds until two consecutive rounds add
  nothing new, deduping against everything already seen (the fixtures overlap on
  purpose — three uniques emerge from two overlapping rounds);
- **`adversarialVerify`** puts three skeptics on every claim, each prompted to *kill*
  it with `refuted=true` as the uncertainty default; majority refutes win, and one
  claim dies exactly that way;
- **`finalReport`** assembles the markdown deterministically — no agent involved.
