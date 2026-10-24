---
name: vibeflow-versioning
description: Changesets, versioning, and the npm + GitHub release procedure for the vibeflow public repo. Use when the user asks to "publish to npm", "release a new version", or "create a GitHub release".
---

# Vibeflow Versioning

## Release procedure (public repo)

1. Create a changeset for every customer-facing change (`.changeset/<short-kebab-description>.md` targeting `"@vibeflow-tools/cli"` with a `patch`/`minor`/`major` bump).
2. Consume the changesets (`pnpm changeset version`), build, verify, and `npm publish` the CLI.
3. After `npm publish` lands, create the annotated tag + GitHub release with `pnpm release:cli` (backed by `scripts/release-cli.mjs`: reads the version from `packages/cli/package.json`, takes notes from the matching `## <version>` section of `packages/cli/CHANGELOG.md`, refuses when the section is missing, idempotent on re-run).
4. Verify with `gh release view v<version>`.

Full sequence: publish → `pnpm release:cli` → verify `gh release view`.

GitHub releases are created locally with `pnpm release:cli` because there is no CI (ADR-0007) — no workflow will do it for you.
