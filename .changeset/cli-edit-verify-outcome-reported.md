---
"@vibeflow-tools/cli": patch
---

`tasks --edit --set-verify` now reports the verdict it wrote, so a success line can no longer look like a dropped one

- The human run prints the verdict outcome (`verify: pass — recorded (verified=true)`, `verify: fail — recorded (verified=false; the review gate blocks it)`, `verify: cannot — no badge (verified left absent); reason recorded in activity`)
- The `--json` payload carries `verification: { verdict, verified, reasonRecorded }`
- A reason that fails to record is now a refusal in human mode too (no green `✓ Task updated` ahead of the failure)

`verified` is a tri-state flag — `true` (the agent verified the task IS correct), `false` (verified it is NOT), **absent** (not assessed, no badge) — and a `cannot` verdict deliberately writes ABSENCE, with its reason recorded as an activity comment rather than as a field. So after `--set-verify cannot --verify-reason "why"` the task file shows no verdict and no reason field, and the only place a caller could learn that both writes happened was a bare `✓ Task updated: <title>`. That silence read as a silently dropped verdict: the verdict had in fact been recorded on annotated and unannotated tasks alike. The local run now states the outcome on both surfaces, and a lost `--verify-reason` (like a lost `--comment`) fails the run with `E_COMMENT_SAVE` instead of a tick plus an exit code.
