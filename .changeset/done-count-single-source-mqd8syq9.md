---
"@vibeflow-tools/ui": patch
---

Done column counts come from one query (ticket mqd8syq9, UI half): the new `doneTotal` prop is the single count source — the Done header reads `Done - N` and the dotted bottom chip reads `showing X of N` (via `doneCountChipText`), both from that one number. Shown (X) is the done tasks actually held and grows as more pages load; the total (N) does not change. Without `doneTotal` the legacy header and no chip render byte-identically to before. Web lane: pass the total that already arrives on the done list response and drop the injected done footer via `columnFooter`.
