---
"@vibeflow-tools/cli": patch
---

Online prefix resolution for every id-taking link flag, plus `tasks --delete`.

Fix 1 — `vibeflow tasks --add --parent <prefix>` (and `--set-parent`,
`--relates`, `--blocks`, `--unrelates`, `--unblocks` on `--edit`) failed in
online mode with `Parent target task <prefix> not found` while the full id
worked: the raw value was passed through to the online API unresolved.
Every id-taking link flag is now resolved against the online board BEFORE
the request — exact id wins, a unique prefix resolves, an ambiguous prefix
is refused naming the candidates (`E_AMBIGUOUS`), and an unknown value is
refused `TASK_NOT_FOUND` naming the value (the same code the local path
answers, instead of the server's `INVALID_LINKS`). `--relates`/`--blocks`/
`--unrelates`/`--unblocks`, previously silently dropped in online mode, now
merge into the PATCH link set with the local path's additive/subtractive
semantics. Push/pull take no task ids (`--board`/`--workspace` only), so no
change was needed there.

Fix 2 — new `vibeflow tasks --delete <id> [--yes]`: resolves the same
prefixes (refusing ambiguity), prints what WOULD be deleted and exits
non-zero without `--yes`, deletes online in online mode
(`DELETE /api/v0/tasks/:id` against the same store every other write uses)
and locally otherwise. A LOCAL parent with children is refused even WITH
`--yes` — the local store does not cascade, so the CLI states the children
and refuses rather than silently orphaning them; delete the children first,
deepest first. The ONLINE delete cascades (the v0 route deletes the whole
descendant cone), so a parent delete proceeds WITH an explicit warning
naming every descendant, reports the server's `deletedIds`, and drops the
matching local records so a later push cannot recreate them. `--json`
success carries `{ ok, deleted, id, deletedIds }`; `--yes --dry-run`
reports the confirmed plan and exits 0 with zero mutations in both stores.
One shared resolver (`resolveSaasTaskId`) serves both stores, the empty id
is refused outright, and the online listing is paged to completion
(`fetchSaasTasks` fails loudly with `BOARD_TRUNCATED` instead of silently
stopping at a page cap, so a child outside the old window cannot bypass
the guard).
