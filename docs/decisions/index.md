# Architecture Decision Records

Start here. Each row is a binding rule. Details live in the linked file.
Code points at these files with `ADR-NNNN`.

| id | title | status | date | rule in one sentence | pins |
|----|-------|--------|------|----------------------|------|
| [0001](0001-v0-project-changelog-cli-local.md) | v0 project/changelog are CLI-local | accepted | 2026-10-25 | `GET /api/v0/project` and `/api/v0/changelog` exist only on the CLI-local server — never add them remotely, never delete them as unused. | `packages/cli/tests/unit/api-v0/scope-gate.test.ts` |
| [0002](0002-online-writes-stay-online.md) | Online writes stay online | accepted | 2026-10-25 | Online writes never touch the local store; only `push`/`pull` materialise it. | `packages/cli/tests/unit/remote-task-store.test.ts` |
| [0003](0003-commit-task-shared-resolve.md) | One shared local-task resolve | accepted | 2026-10-25 | Every short-id resolution goes through `resolveLocalTask`; a second path must never appear. | `packages/cli/tests/unit/git-commit-race.test.ts` |
| [0004](0004-gates-run-locally.md) | Gates run locally | accepted | 2026-10-25 | No remote CI: the pre-commit and pre-push hooks are the gates, releases ship locally. | `.husky/pre-commit` |
| [0005](0005-project-scoped-auth.md) | Auth is project-scoped | accepted | 2026-10-25 | Auth resolves per project from the repo pointer plus user-scoped credentials — never a machine-global token. | `packages/cli/tests/unit/auth/project-auth.test.ts` |

How to add a decision: copy `TEMPLATE.md` to `NNNN-short-name.md`, fill it in,
add one row above, and leave a one-line pointer in the code it governs.
