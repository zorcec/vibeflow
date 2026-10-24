---
"@vibeflow-tools/cli": patch
---

Refuse commits with test author or committer identities, with resolved identities and Git configuration instructions in the error. Check outgoing commits before push and recent history in the unit suite as additional safeguards. The five existing diagnostic-identity commits are permanent exceptions by owner decision, keyed only by their full commit SHAs; a new commit cannot inherit an exception. Local hooks can be bypassed with `HUSKY=0`, `--no-verify` or `core.hooksPath`; the history test still checks when the unit suite runs.
