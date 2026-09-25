# Changelog

All notable changes to Vibeflow are documented here.

Detailed, per-package changelogs are maintained by [changesets](https://github.com/changesets/changesets) inside each package:

- [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md) — `@vibeflow-tools/cli`
- [`packages/prototyping/CHANGELOG.md`](packages/prototyping/CHANGELOG.md) — `@vibeflow-tools/prototyping`

## Releases

| Release | Packages | Notes |
| --- | --- | --- |
| 0.17.1 | `@vibeflow-tools/cli` 0.17.1, `@vibeflow-tools/prototyping` 0.2.1 | Slimmer npm tarball; path-scoped `tasks --commit` |
| 0.17.0 | `@vibeflow-tools/cli` 0.17.0 | Tri-state `--set-verify pass\|fail\|cannot` task verification |
| 0.16.0 | `@vibeflow-tools/cli` 0.16.0 | Replaced boolean verification flags with tri-state verdicts |
| 0.15.0 | `@vibeflow-tools/cli` 0.15.0 | Minor release |

## How releases are made

Changes are merged with a changeset describing their impact. On release, changesets bumps the affected package versions, updates the package changelogs, and the packages are published to npm as `@vibeflow-tools/*`.
