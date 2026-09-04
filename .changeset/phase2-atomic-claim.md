---
"@vibeflow-tools/cli": minor
---

Add atomic claim (claimNextTaskAtomic) shared by CLI `--next` and MCP `claim_next_task`.

- Claim re-reads task status inside a global O_EXCL claim lock and skips already-taken tasks — no lost updates under concurrent claims.
- Author captured from git user (CLI) / gitUserName (MCP) — never overwritten with undefined.
- writeTaskJsonAt preserves the exact file path used during read so legacy flat-layout tasks are updated in place (not shadowed).
