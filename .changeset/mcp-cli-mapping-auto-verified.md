---
"@vibeflow-tools/cli": patch
---

Make the CLI↔MCP mapping automatically verified and fix the four divergences it caught.

- `add_comment`'s `cliRef` now names the form that actually works (`tasks --edit <id> --comment`); a bare `tasks --comment <text>` used to exit 0 while writing nothing and now fails with `E_USAGE` (exit 2). It only affects an invocation that did nothing before.
- The MCP server advertises the real package version instead of `0.1.0` (`serverInfo.version` now equals `package.json`).
- `tools/list` now returns tool `annotations` (readOnly/destructive/idempotent/openWorld hints) — additive for clients.
- `push_tasks` success responses always carry a parseable JSON text payload instead of a possible `text: undefined` envelope.

Verification added: the commander tree is introspectable without executing the CLI (`createProgram()`), G1 fails the build when a CLI flag is neither mapped to a tool nor explicitly classified in `intentionallyNotExposed`, G2 cross-checks commander introspection against the built binary's `--help`, and G4 keeps the MCP layer off argv/commander with every tool delegating to `core/operations`.
