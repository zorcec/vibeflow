---
"@vibeflow-tools/cli": patch
---

CLI online listings use the v0 kanban ordering contract (ticket 05076246, server commits afcb4a41 + LANE Z scope): the default unfiltered root-only listing requests `?scope=roots&sort=kanban&limit=K`, `--children` and pushable-status-filtered listings request `?sort=kanban&limit=K`, each rendering the first page in ONE request with the SAME rows as the full-scan client sort. `--status done`, type/user/tag filters, and prefix resolution stay full-scan with the reason named at the decision point; old servers that ignore or refuse `sort`/`scope` fall back to the full scan. Documents `sort` and `scope` in the public OpenAPI spec.
