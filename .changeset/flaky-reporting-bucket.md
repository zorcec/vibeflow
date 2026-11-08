---
"@vibeflow-tools/cli": patch
---

Flaky-test reporting: failures in `@flaky`-marked specs now land in a separate bucket — printed as `FLAKY (not failing the gate): …` and appended to a machine-readable flake log (path + spec + worker count + timestamp) — instead of hiding inside suite output, while genuine reds still fail the gate. The spec still runs; nothing is skipped and no new `@flaky` tags were added. Ticket f3b5058e.
