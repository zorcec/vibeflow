---
"@vibeflow-tools/cli": patch
---

Filtered task listings no longer hide matching children, and `--next` falls back to a child claim

A todo child of a backlog parent used to be invisible: `--status todo` dropped every matching child whose parent did not match the filter, and `--next` reported "No todo tasks found" while a todo task existed. A filtered listing (`--status`/`--type`/`--tag`/`--user`) now returns every matching task, children included, each with parent context (the relations `parent:` line now carries the parent's status, e.g. `parent: abc12345 Backlog parent [backlog]`). The unfiltered listing keeps the root-only default. `--next` still prefers the highest-priority todo root, but when no todo root is claimable it claims the highest-priority matching child and says so explicitly (human `⤷ CHILD CLAIM …` line; `childClaim: true` plus `parent: { id, title, status }` in `--json`), so a claimable task is never skipped silently.

Deliberately revised rule: "`--next` never returns a child" is now "`--next` prefers roots and falls back to an explicitly-marked child claim when no todo root is claimable" — the owner's invisibility complaint leaves silence unacceptable, while roots-first keeps the root-as-unit-of-work invariant for the common case.
