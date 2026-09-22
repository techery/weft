# Frozen event-contract vectors

`7fe75e9.json` contains hand-authored vectors based on the event, projection, and replay contracts at commit `7fe75e96a9de66143005d392ce6d554b7b98de1e`. Its expected projections and replay counts were checked by executing that commit's reducer and replay-index source against these vectors. The corpus does not claim that these are production logs or runs emitted by a published engine version. Hashes are opaque fixture identities, not claims of real model prompts or repository contents.

The current compatibility test preserves completed results, required-check attempt history, usage totals, and rejected human answers. New procedure/workspace/operation projections must not invent delivery evidence for older histories. The fixture intentionally covers legacy records without a bundle/body stamp.

Keep vectors immutable. Add a new commit/version directory when compatibility behavior changes, and capture real prior-release journals with provenance when available. These contract vectors supplement current-engine restart tests; they do not yet prove full old-engine execution and resumption across published releases.
