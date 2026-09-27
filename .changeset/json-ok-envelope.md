---
"@vibeflow-tools/cli": minor
---

**Breaking for `--json` consumers:** every success payload now uses a single `ok` discriminant.

- `tasks --json` returns `{ok:true, tasks:[…], hiddenChildren}` (was a bare array).
- `tasks --get --json` returns `{ok:true, task:{…}}` (was a flat object).
- `tasks --add|edit|next|commit --json` return `{ok:true, task:{…}, next_actions:[…], …}` (was `success:true`, now `ok:true`).
- Dry-run payloads (`--dry-run`) and `--reindex-sort-keys` payloads carry `ok:true` as their first key; reindex's `success` field became `reindexVerified`.
- Failures stay `{ok:false, error:{code, message, retryable, suggestion}}` on **stderr** with a non-zero exit, written by the same single envelope writer as success. Under `--json` stdout contains only the envelope — human notices are suppressed (or, for a failed `--comment` save, reported as `E_COMMENT_SAVE` on stderr).

Every existing payload field is preserved inside the new envelope — including the list's `hiddenChildren` metadata, which is now machine-readable too. Human (non-`--json`) output is unchanged. This is a breaking reshape, hence `minor` (0.x semver): consumers that parsed the bare array or flat object must read `.tasks` / `.task` and check `.ok` first.
