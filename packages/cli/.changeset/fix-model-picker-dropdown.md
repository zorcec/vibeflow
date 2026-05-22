---
"@vibeflow-tools/cli": patch
---

Two fixes for model pickers in the kanban UI:

1. **CLI kanban now parses tRPC response correctly** — the `/trpc/models` endpoint returns `{ result: { data: { models: [...] } } }` but the CLI API client was expecting the inner shape directly. Now unwraps the tRPC envelope.

2. **ModelPicker dropdown no longer clipped by modal** — replaced absolute positioning with a `createPortal` that renders the dropdown at `position: fixed` using measured button coordinates. The dropdown now expands upward above the button and escapes any parent overflow clipping.