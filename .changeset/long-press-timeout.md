---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Increase kanban multi-select long-press timeout to 750ms with drag cancellation

The long-press timeout to enter multi-select mode on kanban task cards has been
increased from 300ms to 750ms to reduce accidental activation. Additionally,
if the user starts dragging a card (mouse moves more than 5px) before the
timeout fires, multi-select mode is cancelled entirely. This affects both the
webapp and CLI kanban since they share the same TaskCard component.
