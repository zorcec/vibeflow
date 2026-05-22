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

# Run e2e tests
pnpm test:e2e
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

The pre-commit hook will warn if gitleaks is missing but **will not block** the commit. Install it to ensure secrets are never accidentally committed to the public repo.

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

## Pull request checklist

- [ ] Tests added / updated for the change
- [ ] Build passes (`pnpm build`)
- [ ] Unit tests pass (`pnpm test`)
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
