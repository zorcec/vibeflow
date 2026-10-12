---
"@vibeflow-tools/ui": patch
---

Show a visible processing state the moment a screenshot is pasted: the Files pane renders a pending tile with the shared spinner until the stored attachment is listed, the Upload control disables while a batch is in flight so duplicates cannot stack up, and a failed upload (transform error, rejected upload, or an upload that resolves without the file appearing) lands in the visible upload-error box instead of failing silently. Create-task mode shows a "Processing pasted image…" pill until the paste is buffered, with transform failures surfaced the same way.
