---
"@vibeflow-tools/cli": minor
---

Push honesty (dec52322): the shared bulk-push loop records each refusal's HTTP status plus the server error code and reports TRUE grouped counts (e.g. "60 created, 1319 refused: 402 plan-limit ×1319") instead of the false "already existed" line — the v0 create op has no duplicate detection. The loop stops early on 402 plan-limit and 429 quota (further POSTs futile) and prints the server's message loudly with the 429 retry-after; the login-time "not on the board" diff is labelled as the client-side attempt list rather than a sync promise; skipped links summarize by type with the first few shown and the full list behind --verbose/--json. Progress still advances on every attempt (k/N invariant unchanged).
