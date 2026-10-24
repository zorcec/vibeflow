---
"@vibeflow-tools/cli": patch
---

Fixed `push --board <id>` / `pull --board <id>` failing without a prior `auth login`: the import, task-create, file-upload, link-replay, and archive steps now carry the resolved board as `X-Vibeflow-Scope`, instead of only the capability probe doing so. On a multi-board account every one of those calls previously answered 422 SCOPE_REQUIRED, so scripted push/pull against a fresh board failed 100% of the time. Per-file failure lines are unchanged.
