---
"@vibeflow-tools/ui": patch
---

Done column counts (d2zka3bd): the header shows the server-known total (`Done · N`) and the single bottom line reads `+N more` with N = total − rendered-on-screen. The duplicate `showing X of N` dotted chip is removed; `doneCountChipText` is replaced by the `doneHiddenCount(rendered, total)` remainder helper.
