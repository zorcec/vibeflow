---
"@vibeflow-tools/cli": patch
---

Agent chat flag is now `VIBEFLOW_FEATURES=CHAT` instead of a dedicated
`VIBEFLOW_AGENT_CHAT=1`. One env var gates every opt-in surface; the
value is a comma- and/or space-separated list (`CHAT,FOO BAR`) matched
case-insensitively, so future flags need no new plumbing. Behavior with
the flag absent is unchanged (chat fully off, zero surface).
