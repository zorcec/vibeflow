---
"@vibeflow-tools/cli": patch
---

Shared review gate (review-gate.ts) + PATCH whitelist + MCP update_task parity. Extracts CLI gate logic into a shared module used by CLI, REST PATCH, and MCP update_task. PATCH route now filters mass-assignment keys. MCP update_task enforces comment/commit/verify/research gates. Git commit helper (git.ts) shared by CLI commit mode and auto-commit.
