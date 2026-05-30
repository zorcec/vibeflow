---
"@vibeflow-tools/cli": patch
---

feat: add Show Vibeflow option to page context menu when badge is hidden

When the Vibeflow badge is hidden via the corner trigger's right-click menu,
it was previously impossible to restore it. Now, right-clicking any page element
shows a "Show Vibeflow" option in the context menu, allowing users to bring the
badge back.

The hidden state is also persisted to localStorage so it survives page reloads.
