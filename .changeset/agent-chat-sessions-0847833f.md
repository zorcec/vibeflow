---
"@vibeflow-tools/cli": patch
---

Agent chat foundation (ticket 0847833f, part 1, behind
`VIBEFLOW_FEATURES=CHAT`). New server-side chat session manager: one
long-lived `pi --mode rpc` child per chat session (LF-only JSONL
framing, per-command correlation, idle expiry, concurrency cap), plus
the pure pi→overlay event mapper (`agent:token` / `agent:tool-call` /
`agent:tool-result` / `agent:done`). No routes wired yet — sessions and
mapping ship first with bulletproof unit coverage.
