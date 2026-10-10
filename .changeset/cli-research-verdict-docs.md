---
"@vibeflow-tools/cli": patch
---

Document the Research-verdict refusal where the flags are documented

A verdict on a `type:"Research"` task has been refused since 0.18.0 — the review
gate, the CLI's standalone `--set-verify` check, and the MCP `setVerify` path
all return `RESEARCH_VERIFY_NOT_ALLOWED` — but the README said so only in the
MCP section, so a reader of the `--set-verify` flag docs learned three verdict
forms with no mention of the one type that takes none of them. The flag docs
now carry the warning directly, and a doc test pins both its position (the
line after the last `--set-verify` flag) and the code it names to
`RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL`, so the documented claim cannot drift
from the CLI.

Regression tests pin the rule at the write boundary rather than at the gate:
all three verdict forms on a Research task exit non-zero AND leave the task
byte-identical (no verdict, no status change, no `cannot` reason comment), the
review transition still refuses on the verdict before the missing-report gate,
and Bug/Feature tasks still take `pass`, `fail` and `cannot`.
