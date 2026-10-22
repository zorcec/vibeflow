---
"@vibeflow-tools/ui": patch
---

Tag bulk-remove confirmation (ticket db2fce26): Enter no longer confirms from any focused control — `ConfirmModal` only confirms when its own confirm button is focused (or focus is outside buttons), so focus-Cancel + Enter can never delete. Close/cancel requests (Escape, Cancel, backdrop) are ignored while a removal is pending via a synchronous in-flight ref, so confirm → Escape → confirm can never put two calls in flight; the dialog stays open on its spinner until the first call settles.
