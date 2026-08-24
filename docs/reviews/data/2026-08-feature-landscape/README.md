# Source data for the 2026-08 feature landscape report

Machine-readable artifacts behind [`../../2026-08-feature-landscape.md`](../../2026-08-feature-landscape.md).
Produced 2026-08-24 against `da85488`. Kept so every claim in the report can be traced, re-queried, or
regenerated without re-running the research.

| File | Shape | What it holds |
| --- | --- | --- |
| `inventory.json` | `[{ area, features[{ name, description, evidence, maturity }], limitations[{ what, evidence }] }]` | 140 verified weft capabilities with `file:line` evidence, and 71 proven limitations. Three areas: core engine, hosts/tooling, providers/git/stdlib. |
| `landscape.json` | `[{ cluster, projects[{ name, repo, language, license, popularity, positioning, features{…}, strengths, weaknesses, ideasWorthStealing }] }]` | 84 open-source projects across six clusters, each rated on ten feature axes. Web-sourced and dated — re-check before relying on it. |
| `comparison.json` | `{ dimensions[{ dimension, weft, others[{ project, rating, note }] }], closestCompetitors, weftUniqueStrengths, weftGaps, positioningStatement }` | The 18-dimension comparison, closest competitors, unique strengths, and gaps by severity. |
| `ideas.json` | `[{ title, category, problem, proposal, sketch, priorArt, effort, impact, risks, fitsArchitecture }]` | All 42 raw feature ideas, including the ones the critic cut. `sketch` holds the API/CLI sketch for each. |
| `critic.json` | `{ duplicateAlreadyExists, weakIdeas, missingProjects, missingDimensions, missingIdeas, factualCorrections, topTen }` | The adversarial pass: what was already shipped, what does not survive contact with the architecture, what was never covered, and the ranked ten. |

Useful queries:

```sh
# every limitation with its evidence
jq -r '.[].limitations[] | "- \(.what)\n  \(.evidence)"' inventory.json

# which projects were rated "strong" on a dimension
jq -r '.dimensions[] | select(.dimension|test("Budget")) | .others[] | select(.rating=="strong") | .project' comparison.json

# the full sketch for one idea
jq -r '.[] | select(.title|test("reads:")) | .sketch' ideas.json
```
