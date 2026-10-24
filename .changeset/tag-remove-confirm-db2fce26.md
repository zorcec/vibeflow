---
"@vibeflow-tools/ui": patch
---

Tag bulk-remove confirmation is now hard to trigger by accident: Enter no longer confirms from any focused control — only the confirm button (or focus outside buttons) confirms. Closing the dialog (Escape, Cancel, backdrop) is ignored while a removal is pending, so two removals can never be put in flight; the dialog stays on its spinner until the first call settles.
