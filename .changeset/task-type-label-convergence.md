---
"@vibeflow-tools/cli": patch
---

Fix local↔cloud convergence for user-written task `type` labels (task 2883138e). `normalizeTaskTypeValue` treated `type` as a closed enum and read every undocumented label (e.g. `Chore`) as absent, so push sent a record without the key, the server stored `raw.type = null`, and the local label could never converge (`push` re-reported the task, `pull` left it untouched, the verifier flagged L1 `type` forever). `type` is now a free-form label: any non-empty, non-artifact string round-trips verbatim through read → push → pull, with only stringified artifacts (`[object Object]`), empties, and non-strings reading as absent. The pull file plan additionally never materialises staged bytes the merged record disowns — a `linkedPath` cover, or a `files[]` array that does not reference the staged name (stale server row) — counted as `filesSkipped` so the summary matches the filesystem.
