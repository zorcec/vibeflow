---
"@vibeflow-tools/cli": patch
---

Login-time push uploads file attachments (ticket 0aac5938). The
login-time push did tasks → links and stopped, silently dropping every
attachment; it now runs the same shared phase-3 uploader as standalone
push (batch when probed, sequential on old servers). Login never deletes
local files, so upload failures only warn — a later `vibeflow push`
retries them.
