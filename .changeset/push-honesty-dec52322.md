---
"@vibeflow-tools/cli": minor
---

Push now reports true grouped counts (e.g. "60 created, 1319 refused: 402 plan-limit ×1319") with each refusal's HTTP status and server error code, instead of a false "already existed" line. The loop stops early on 402 plan-limit and 429 quota and prints the server's message loudly with the retry delay. Skipped links summarize by type with the full list behind `--verbose`/`--json`.
