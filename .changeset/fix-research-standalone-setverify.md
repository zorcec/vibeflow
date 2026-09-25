---
"vibeflow": patch
---

Fix standalone `--set-verify` on Research tasks: previously `--set-verify pass` on a Research task silently succeeded (exit 0) without writing anything, and `--dry-run --set-verify pass` showed `verified: true` in the preview. Both now error with `RESEARCH_VERIFY_NOT_ALLOWED` and non-zero exit, matching the existing review-gate behaviour.
