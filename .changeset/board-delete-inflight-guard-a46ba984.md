---
"@vibeflow-tools/ui": patch
---

Board delete modal blocks Cancel while the delete request is in flight (ticket a46ba984): Cancel disabled, progress state on the confirm button, Escape/backdrop ignored. On failure Cancel re-enables and the error is shown.
