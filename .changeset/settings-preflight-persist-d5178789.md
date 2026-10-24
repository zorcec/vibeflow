---
"@vibeflow-tools/cli": patch
---

Persist the settings pre-flight debounce across CLI invocations. The 5-minute check window was module-memory-only, so every fresh CLI process re-fetched `/api/v0/settings`. A tiny `{ identityHash, checkedAt, settingsHash, settingsFingerprint }` stamp now lives in a project-local unsynced dir (`.vibeflow-state/`, never the synced store, no secrets or settings payload): in-window invocations issue zero settings requests, account/token rotation and independent settings edits re-arm eligibility, concurrent invocations race a non-blocking lease instead of hanging, and corrupt or unwritable state fails open. Settings writers also use unique temp names so concurrent projects sharing the global file cannot collide.
