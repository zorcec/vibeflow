"@vibeflow-tools/cli": patch
---

Add `put-baseline-page` to the v1 contract (P3-A cutover): `POST /api/v1/tasks/{id}/baseline-page` (`tasks:write`), mapped to the local `POST /api/tasks/:id/baseline-page` handler (stores `{ page: { version: 1, elements, capturedAt, truncated } }` as the `baseline-page.json` system file), with regenerated spec, registry, and manifest row. No existing endpoint changed.
