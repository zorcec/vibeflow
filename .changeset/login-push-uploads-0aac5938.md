---
"@vibeflow-tools/cli": patch
---

Login-time push now uploads file attachments. It runs the same uploader as standalone `push`, so attachments are no longer silently dropped at login. Login never deletes local files, so upload failures only warn — a later `vibeflow push` retries them.
