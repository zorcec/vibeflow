---
"@vibeflow-tools/ui": patch
---

File add/remove activity rows now render a lucide action icon (Paperclip for additions, Trash2 for removals) instead of the stored emoji prefix. The icon is sized to the other activity glyphs and labelled for screen readers, and the human text renders intact minus the emoji. Stored trace text is unchanged, so existing boards and text assertions keep working.
