# audit-and-fix changelog

## Unreleased

- Require complete discovery and refutation before approval. Group all same-file findings into one writer and integrate before starting another writer.
- Report fixes only from merged patches; use strict write scopes and fail on integration conflict.
- Add portable behavior tests, including scratch-Git integration with shared regression tests and declined approval.
- Adopt the standard workflow package layout.
