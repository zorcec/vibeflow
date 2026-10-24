---
"@vibeflow-tools/cli": minor
---

New `vibeflow tasks --delete <id> [--yes]`: resolves full ids and unique prefixes (refusing ambiguity), prints what would be deleted and exits non-zero without `--yes`. A local parent with children is refused even with `--yes` — delete the children first, deepest first. The remote delete cascades, so a parent delete warns naming every descendant and drops the matching local records so a later push cannot recreate them. `--json` carries `{ ok, deleted, id, deletedIds }`, and `--yes --dry-run` previews with zero mutations.

Every id-taking link flag (`--parent`, `--set-parent`, `--relates`, `--blocks`, `--unrelates`, `--unblocks`) now resolves prefixes against the remote board before the request — exact id wins, a unique prefix resolves, an ambiguous prefix is refused naming the candidates — instead of failing with a not-found error for values `--get` displays.
