---
"@vibeflow-tools/cli": patch
---

Research tasks can no longer carry a `verified` attestation.

A Research task produces a report and has no annotated UI element to verify, so any
`verified` value on it is meaningless — and under the tri-state semantics a stored
`false` reads as "verified as NOT implemented correctly", an active lie. The value is
now scrubbed on read (`normalizeTask`) and on write (`updateTask` / `writeTaskJson`),
so it can never be observed or persisted whatever wrote it.

The review gate no longer demands a verification attestation for a Research task, even
when it has a URL and selector (the reproduced case: a Research task with
`url` + `selector "#main"` had its review transition refused until `--skip-verify`).
An attestation passed on a Research review transition is now refused loudly with
`RESEARCH_VERIFY_NOT_ALLOWED` instead of being dropped silently. Task, Bug, Feature,
and Enhancement tasks are unaffected.
