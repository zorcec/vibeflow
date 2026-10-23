---
"@vibeflow-tools/cli": patch
---

Route the shared task create/edit/comment operations through authoritative remote writes. In remote mode `create_task`, `update_task`, and `add_comment` now POST/PATCH the board they resolved against (one awaited request per write, no local file on success or refusal) instead of landing locally while the existence check read remotely. Structured server refusals keep their own code, and the review auto-commit stays a local-only effect that skips board-only tasks silently.
