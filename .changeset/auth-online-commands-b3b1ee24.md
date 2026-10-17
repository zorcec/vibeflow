---
"@vibeflow-tools/cli": patch
---

User-facing wording for the logged-in state now says "online" everywhere: the login banner, the status line, watch and push output, help text, and the README (ticket b3b1ee24). `vibeflow auth login`, `vibeflow auth logout`, and `vibeflow auth status` are the canonical commands — bare `vibeflow auth` shows the same status, and the old bare `login` / `logout` spellings still work but print a redirect notice. Covered end to end against a stub backend: login, push, create, and detailed retrieval, plus refusal-path tests for bad credentials and the empty-boards case.
