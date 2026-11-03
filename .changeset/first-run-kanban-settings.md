---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

First-run kanban onboarding: opening a board with no tasks auto-opens settings once (localStorage `vibeflow.kanban.onboarded`, never re-opens), and the review-gate defaults are now ON — a verification verdict and a comment are required on review unless explicitly opted out (`requireVerifyBeforeReview: false` / `autoComment: false` still win). Comment-on-review was already unconditional; the verify default is the behavior change, surfaced visibly by the auto-opened settings modal.
