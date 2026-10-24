---
"@vibeflow-tools/cli": patch
---

Fixed `tasks --commit --task` failing to resolve a short task id. The commit-link path now resolves through the same shared id rule every other flag uses: an exact id wins, a unique prefix resolves, an ambiguous prefix refuses naming the candidates, and an unknown id says not found. The commit and the record link stay local; only the resolution follows the board when one is configured.
