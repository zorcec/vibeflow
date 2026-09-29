# Changelog

All notable changes to Vibeflow are documented here.

Detailed, per-package changelogs are maintained by [changesets](https://github.com/changesets/changesets) inside each package:

- [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md) — `@vibeflow-tools/cli`
- [`packages/prototyping/CHANGELOG.md`](packages/prototyping/CHANGELOG.md) — `@vibeflow-tools/prototyping`

## Highlights

Cross-cutting changes worth reading about on their own. Everything else is in the [release table](#releases) below or in the per-package changelogs.

- **The MCP server is stable as of 0.18.0.** It shipped in 0.12.0 under a warning that it could change without notice; that warning is gone from the CLI help, the tool manifests and the release notes. The surface a client can pin to now resolves one project root per server, answers every refusal with a code and a recovery hint, and honours `dryRun` as a preview that writes nothing. See [the MCP guide](https://www.vibeflow.tools/docs-mcp).
- **Refusals are machine-readable on every surface.** A refusal is `{ok:false, error:{code, message, retryable, suggestion?}}` on the CLI, over HTTP and over MCP — one parser, one vocabulary, and one recovery text per code, naming the CLI flag *and* the MCP input so a client is never told to use a flag it does not have.
- **An empty board is a success on both surfaces.** `tasks --next --json` and MCP `claim_next_task` now answer the same situation the same way (`task: null`), instead of one exiting 0 with prose and the other refusing with a code.

## Releases

| Release | Packages | Notes |
| --- | --- | --- |
| 0.17.1 | `@vibeflow-tools/cli` 0.17.1, `@vibeflow-tools/prototyping` 0.2.1 | Slimmer npm tarball; path-scoped `tasks --commit` |
| 0.17.0 | `@vibeflow-tools/cli` 0.17.0 | Tri-state `--set-verify pass\|fail\|cannot` task verification |
| 0.16.0 | `@vibeflow-tools/cli` 0.16.0 | Replaced boolean verification flags with tri-state verdicts |
| 0.15.0 | `@vibeflow-tools/cli` 0.15.0 | Minor release |

## How releases are made

Changes are merged with a changeset describing their impact. On release, changesets bumps the affected package versions, updates the package changelogs, and the packages are published to npm as `@vibeflow-tools/*`.
