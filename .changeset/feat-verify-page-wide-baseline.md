---
"@vibeflow-tools/cli": minor
---

feat(verify): page-wide baseline capture and diff

- Capture page-wide baseline at annotation time, store as baseline-page.json
- Remove baseline from task.json (too large), use file reference instead
- Enable page-wide diff at verify time (verify-page-diff.json)
- Add html_query tool for structural HTML changes
- Back-fill baseline values in verify-all-styles.json for accurate diffs
