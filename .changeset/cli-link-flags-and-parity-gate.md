---
"@vibeflow-tools/cli": minor
---

Add `--relates`, `--blocks`, `--unrelates` and `--unblocks` to `vibeflow tasks --edit`, closing the last real capability gap between the CLI and MCP.

`relates` and `blocks` links were settable **only** over MCP. The CLI could set or clear a parent and nothing else, so a user working in the terminal could not express a relationship the MCP surface supported. All four flags are repeatable, accept a full id or a prefix, and route through the same `buildAddLinks` / `buildRemoveLinks` helpers that `update_task`'s `addLinks` / `removeLinks` use — so the two surfaces produce identical results by construction, not by coincidence.

Every flag is additive and surgical: naming one link never touches another. That is the whole guarantee `--set-parent` already gave, now extended to the other two link types.

```bash
# add, keeping the parent and everything else intact
vibeflow tasks --edit <id> --relates <other> --blocks <other>

# remove exactly one, leaving the rest alone
vibeflow tasks --edit <id> --unrelates <other>
```

Re-adding an existing link is a no-op, and an unknown target is refused `TASK_NOT_FOUND` without writing.

The replace-semantics `links` field stays MCP-only on purpose: every CLI flag here preserves links it does not name, and a human should not be handed a flag that deletes what it omits.

### Parity quality gate

Adds two gates that close the loop the existing `G1` could not, plus a semantic-parity suite that compares **outcomes** rather than names.

- **G5** — walks every MCP tool input field and fails if it maps to no CLI flag and is not classified in a new `mcpOnlyFields` export. G1 only walked the CLI; it never asked whether an MCP field corresponded to anything a CLI user can type. That blind spot is how `update_task` shipped `cliRef: ["--set-parent"]` — surgical flags — beside a destructive whole-set `links` replace, and every gate stayed green.
- **Stale-entry guard** — `mcpOnlyFields` fails on an entry naming a field that no longer exists, and on a reason under 20 characters. An unexamined exemption reads as reviewed, which is worse than a missing one.
- **Semantic parity** (`mcp-cli-parity.test.ts`) — drives both surfaces from identical starting state and compares the resulting links on disk: parent swap, cycle refusal, idempotence, and the CLI/MCP link flags agreeing field for field. One test deliberately **pins** the `links` divergence so it cannot regress unnoticed.

G5 caught a real manifest bug on its first run: `attach_file`'s `cliRef` named only `--report-file`, omitting `--edit` and `--set-status`, though the real CLI form is `tasks --edit <id> --set-status review --report-file <path>`. Fixed.

Tests: unit 1560, e2e 345 (1 pre-existing skip), `tsc --noEmit` clean.