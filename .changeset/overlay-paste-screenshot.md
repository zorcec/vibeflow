---
"@vibeflow-tools/cli": patch
---

Overlay task forms: paste-to-attach screenshots again. Pasting an image into the floating popover or the add-task modal buffers a quiet thumbnail chip (32px preview, filename, × to remove) and uploads it as a task file on save; other file kinds attach as-is. Plain-text paste is never intercepted.
