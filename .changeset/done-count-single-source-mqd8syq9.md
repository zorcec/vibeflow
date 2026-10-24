---
"@vibeflow-tools/ui": patch
---

Done column counts come from one query: the Done header reads `Done - N` and the dotted bottom chip reads `showing X of N` from the same total. Shown (X) grows as more pages load while the total (N) stays put. Without the total, the legacy header renders as before.
