---
"@vibeflow-tools/cli": patch
---

Pre-push is now affected-only: the hook derives the changed paths from the push range and runs only the suites those paths can break via an explicit path→suite map (`scripts/affected-suites.mjs`), instead of unit+e2e+integration+playwright unconditionally. Unmapped paths, a shallow/unavailable base, or a force push run everything (fail closed); docs/changeset-only pushes run nothing. `node scripts/affected-suites.mjs --dry-run --range <base>..<head>` prints the chosen suites for review without pushing. Tickets 6fc455a3.
