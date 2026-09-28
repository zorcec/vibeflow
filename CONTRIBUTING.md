# Contributing to Vibeflow

## Setup

Requirements: Node.js ≥ 22, pnpm ≥ 9

```bash
# Install dependencies (also sets up git hooks)
pnpm install

# Build the CLI
pnpm build

# Run unit tests
pnpm test

# Run integration tests
pnpm test:integration

# Run e2e tests
pnpm test:e2e

# Run browser tests (needs a browser once: npx playwright install chromium)
pnpm test:browser
```

### Secret scanning (required)

Install [gitleaks](https://github.com/gitleaks/gitleaks#installing) before your first commit:

```bash
# macOS
brew install gitleaks

# Linux
curl -sSfL https://raw.githubusercontent.com/gitleaks/gitleaks/main/scripts/install.sh | sh -s -- -b /usr/local/bin

# Windows (via Chocolatey)
choco install gitleaks
```

The pre-commit hook **will block** the commit if gitleaks is missing — it exits 1 with an install message rather than warning and continuing. Install it before your first commit, otherwise every commit fails at the secret-scan step.

## Development workflow

1. Pick an issue or open one describing the change
2. Create a feature branch: `feat/your-feature` or `fix/the-bug`
3. Make your changes with tests
4. Push the branch and open a pull request

```bash
git checkout -b feat/your-feature
# ... make changes ...
git push origin feat/your-feature
```

## Branch naming

| Prefix | Use for |
|--------|---------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `docs/` | Documentation only |
| `refactor/` | Code restructuring, no behaviour change |
| `test/` | Test additions or fixes |
| `chore/` | Tooling, build, dependencies |

If you are a coding agent, use: `agent/feat-name` or `agent/fix-name`.

## Required checks

Every suite has its own script and no script runs the others, so a green
`pnpm test` says nothing about the other three. All of these must pass
before a change is committed:

| Command | What it covers |
| --- | --- |
| `pnpm run lint:symbols` | ESLint over `packages/*/src/**` |
| `pnpm --filter @vibeflow-tools/cli run lint` | `tsc --noEmit` |
| `pnpm run test` | unit |
| `pnpm run test:integration` | integration (verify flow across a temp project) |
| `pnpm run test:e2e` | end-to-end (CLI spawned as a child process) |
| `pnpm run test:browser` | browser (Playwright) — **required for any UI change** |
| `pnpm run build` | tsup bundles for the shipped CLI |

`lint:symbols`, `lint`, `build` and `test` are what the pre-commit hook
runs for you. Integration, e2e and browser are not in the hook — the
browser suite needs a browser a contributor may not have installed, so it
stays a documented step rather than a hook that fails locally.

## Pull request checklist

- [ ] Tests added / updated for the change
- [ ] `pnpm run lint:symbols` and `pnpm --filter @vibeflow-tools/cli run lint` pass
- [ ] `pnpm run test` passes (unit)
- [ ] `pnpm run test:integration` passes
- [ ] `pnpm run test:e2e` passes
- [ ] `pnpm run test:browser` passes (always for UI changes)
- [ ] `pnpm run build` passes
- [ ] No secrets in committed files (`pnpm scan:secrets:full`)
- [ ] PR title follows `type: description` convention (e.g. `fix: overlay flicker on Safari`)

## Architecture

```
packages/
  cli/      @vibeflow-tools/cli   — CLI tool, local server, browser overlay, kanban
  ui/       @vibeflow-tools/ui    — Shared React components (kanban, task cards)
  shared/   @vibeflow-tools/shared — Zod schemas, collab types, shared utils
```

See [packages/cli/src/](packages/cli/src/) for the CLI source and [README.md](README.md) for the full command reference.

## Releases

Versioning uses [Changesets](https://github.com/changesets/changesets).

```bash
# Create a changeset for your PR
pnpm changeset
```

Maintainers handle the actual release.
