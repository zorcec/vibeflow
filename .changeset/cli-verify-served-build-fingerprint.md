---
"@vibeflow-tools/cli": patch
---

`vibeflow verify` records WHICH build it measured

A served-build fingerprint (sha256 of the served page's inlined bundle + CSS, or
its content-hashed asset URLs, plus its version stamp) is printed next to the
evidence paths and stored in `verify-after.json` / `baseline.json` / the
`--json` result. A board still serving an old bundle no longer looks exactly
like a board serving the build under test.
