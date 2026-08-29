---
"@vibeflow-tools/cli": patch
---

Harden REST API input validation for comments and file uploads to match tRPC validation: add `isValidCommentId` (16-char hex) for all comment endpoints, `isValidFilename` rejecting traversal/control chars for file endpoints, and whitespace-only rejection on comment text.
