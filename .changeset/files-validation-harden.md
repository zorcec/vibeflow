---
"@vibeflow-tools/cli": patch
---

File upload validation hardened: rejects filenames with leading dots, enforces max length (255 chars), and validates extensions against an allowlist. 24 new tests.
