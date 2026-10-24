---
"@vibeflow-tools/cli": patch
---

Fixed local↔cloud convergence for user-written task `type` labels: `type` is now a free-form label, so any non-empty, non-artifact string round-trips verbatim through read → push → pull. Previously an undocumented label (e.g. `Chore`) was treated as absent, so push sent no key, the server stored null, and the local label could never converge. The pull file plan also never materializes staged bytes the merged record disowns, counted as `filesSkipped` so the summary matches the filesystem.
