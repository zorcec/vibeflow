---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

verification verdict is inlined with the task status in the details panel — quieter, more minimal, same tooltips

The details panel no longer renders the verdict as a separate labelled
"VERIFICATION" row above the tabs. The verdict now lives inside the status
chip cluster as one quiet inline note — glyph plus a single word ("Verified"
muted, "Verification failed" in the warning tone) — so the header reads as a
single unit. The hover tooltip, aria-labels, `data-verify-state`, and the
`#dp-verify-row` container (span first child) are unchanged.
