---
"@vibeflow-tools/cli": patch
---

Fix task file attachments and screenshots failing to download when the server runs under Express 5. Attachment routes now pass `dotfiles: "allow"` explicitly instead of relying on the framework default, so files stored under the `.vibeflow` data directory are always served.
