# 02 · Humans in the loop

Humans are steps (C5): a gate suspends the run **durably**. The process can exit, hours
can pass, and the answer can arrive from any channel — the next resume continues from
that exact line.

```sh
npx tsx examples/02-human-in-the-loop/main.ts
```

Three `Engine` instances over one shared journal play three separate processes:

1. **start** — the run reaches `ctx.gate({ risk: "high" })`, the approval policy says
   *ask*, and the run suspends with a pending request;
2. **answer** — a different engine appends the `human.answered` event, the way
   `weft answer <run> h1 '{"approved":true}'` or the web UI would;
3. **resume** — a third engine replays the run. Its mock has **no fixtures**, so the
   fact that it completes proves every agent step was served from the journal.

The second workflow shows timeout policy: a `ctx.human.ask` with `timeout: "300ms"` and
`onTimeout: { default: … }` answers itself when nobody shows up, and the journal records
`answeredBy: "timeout"`.
