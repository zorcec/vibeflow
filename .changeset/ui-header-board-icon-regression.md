---
"@vibeflow-tools/ui": patch
---

Lock the kanban header to the board-configured icon with a regression test

The shared kanban header renders the board's configured icon when one is
provided (`projectIcon`) and keeps the Vibeflow brand mark only as the
fallback for boards without an icon. A new `Header.project-icon` suite pins
that arbitration — board icon present means the Vibeflow mark is absent and
vice versa — plus the 32px icon box and the whitespace-counts-as-missing
rule, so a future change that ignores `projectIcon` fails loudly instead of
silently repainting every board with the brand mark. No visual change: the
header renders exactly as before.
