---
"@vibeflow-tools/cli": patch
---

Harden file-upload validation in MCP attach_file and CLI/API upload routes.

- Move isValidFilename + ALLOWED_FILE_EXTENSIONS to core/files.ts as canonical exports (single source of truth)
- Add MAX_FILENAME_LENGTH (255) and isAllowedFileExtension() helpers
- New validateFilename() function returns typed INVALID_FILENAME / UNSUPPORTED_FILE_TYPE / VALIDATION errors
- Reject leading-dot filenames (covers .linked.json, .env, .git* reserved names)
- MCP attachFile operation gates with validateFilename before saveFile (blocks manifest overwrites, oversized uploads)
- CLI server routes switch to shared helpers (400/415 semantics unchanged)
- 24 new unit tests covering filename table, extension allowlist, size limits, and error codes
