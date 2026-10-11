---
"@vibeflow-tools/cli": patch
---

Pin the baseline projection contract and fail loudly on malformed baselines

### Highlights

- New single source of truth `core/baseline-projection.ts`: `projectPageSnapshot` / `projectElementSnapshot` keep exactly the fields verify and the query tools read (`after`, `selector`, `tag`, `childCount`, `childSignature`, `text`, `dataAttrs`, `position` per page element, plus the structural envelope; the full `DomSnapshot` field set minus `xpath`/`parentSnippet`/`scrollPosition` per element baseline), and document the deliberately dropped fields (`baseline`, `parentKey`, `classes`, inner `key`) with reasons
- `computeDiff` and the `page-diff` query functions now take the projected (minimal-read) shapes, so a future read of a dropped field fails the type-check instead of silently breaking projected baselines
- `verify` and the verify query tools validate baseline artifacts at the boundary: a projected baseline (droppables absent by design) parses cleanly, while a present-but-malformed artifact throws `E_BASELINE_MALFORMED` (or `E_BASELINE_TRUNCATED` for a capped-subset baseline) instead of degrading to undefined back-fills
- Pinned by `tests/unit/baseline-projection.test.ts` (40 tests): exact field sets, per-consumer read coverage, and an equivalence proof — the real `computeDiff` / page-diff queries run over the real baseline pair produce identical verdicts from the full and the projected form
