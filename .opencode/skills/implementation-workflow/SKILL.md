---
name: implementation-workflow
description: Implementation checklist, permissions, and code review graph guidance for the vibeflow project. ALWAYS load this skill when implementing ANY change — bug fixes, features, enhancements, refactoring, or test additions. Also load when the user asks to "review my code before submitting", "what should I check before marking review", "how to use code-review-graph", or when completing an implementation and preparing to set a task to review status.
---

# Implementation Workflow

## Implementation Checklist

Before setting any task to `review`, run through this checklist:

- [ ] **Code compiles** — build succeeds for the affected package
- [ ] **Type-check passes** — `pnpm --filter <package> run lint` (CLI) or `pnpm --filter <package> run typecheck` (web)
- [ ] **Unit tests pass** — `pnpm --filter <package> run test` — all green
- [ ] **Mutation tests** — ALWAYS run before review:
  - CLI: `cd /home/zorcec/workspace/vibeflow-workspace/vibeflow && pnpm --filter @vibeflow-tools/cli run mutation`
  - Web-crawl: `cd /home/zorcec/workspace/vibeflow-workspace/vibeflow-private && pnpm --filter @vibeflow-tools/web-crawl run mutation`
  - Review any surviving mutants and add tests to kill them (or confirm they are false positives)
- [ ] **Playwright tests** — if overlay/kanban bundles changed: build first, then `pnpm --filter <package> run test:browser`
- [ ] **Visual verification** — for UI/layout changes, open in browser and confirm it looks correct on both wide and narrow screens
- [ ] **Changeset created** — ALWAYS run `pnpm changeset` before review. Describe what changed and why. No exceptions.
- [ ] **Committed in correct repo** — CLI changes in `vibeflow/` (public), web changes in `vibeflow-private/` (private)
- [ ] **Task updated in private repo** — `cd vibeflow-private && node ../vibeflow/packages/cli/dist/cli/index.js tasks --edit <id> --set-status review --comment "..."`
- [ ] **Skills reviewed and improved** — load `skill-improvement` skill. Fix any factual errors encountered during the session (wrong commands, outdated paths, incorrect defaults). Add gaps only if encountered 2+ times. Never make stylistic changes proactively. Commit skill improvements:
  ```bash
  cd /home/zorcec/workspace/vibeflow-workspace/vibeflow-private
  git add .opencode/skills/ && git commit -m "improve(skill): <name> — <what changed>" && git push
  ```

## Permissions

Allowed without asking:
- Read any file
- Type-check individual files
- Run a single unit or e2e test file
- Format / lint a file
- Build a package

Ask first:
- Install new packages
- `git push` or publish
- Delete or rename files
- Run the full Playwright suite against a live server
- Destructive file changes

## Code Review Graph (code-review-graph MCP)

The code-review-graph MCP provides structural code analysis. Use it when the task benefits from understanding code relationships — **but skip it for localized changes**.

### When to use graph tools

- Refactoring (renames, extractions, moves) — `refactor_tool`, `get_impact_radius`
- Complex bug fixes — `query_graph pattern=callers_of` to trace execution
- API changes affecting multiple call sites — `get_affected_flows`
- Multi-file changes (5+ files) — `detect_changes`, `get_review_context`
- Unfamiliar code areas — `get_architecture_overview`, `list_communities`

### When to skip graph tools

- UI component fixes — use `grep` + `read` instead
- Single-file changes — graph overhead exceeds benefit
- Test additions — follow existing patterns directly
- Simple feature additions — read similar code, then implement

### Recommended workflow

```
1. Is this a refactor, complex bug, API change, or multi-file change?
   Yes → use graph tools
   No  → skip to standard tools (grep → read → edit)

2. If using graph tools:
   a. get_minimal_context (~100 tokens) — check risk score
   b. If risk > 0: detect_changes detail_level=minimal (~600 tokens)
   c. For relationships: query_graph pattern=callers_of|tests_for
   d. Always use detail_level=minimal unless you need full source
```

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Key rules

- Don't pass `changed_files` explicitly — let the tool auto-detect from git
- Fall back to `grep`/`read` when the graph doesn't cover what you need
- Use `detail_level=minimal` unless you specifically need full source snippets

## Efficiency Tips

Based on session analysis, these patterns save the most tokens:

1. **Use `grep` before `read`** — search for patterns first to find exact locations
2. **Batch independent edits** — multiple unrelated changes to the same file in one message
3. **Run tests strategically** — run full suite only after all changes, not after each edit
4. **Use `detail_level=minimal`** for graph tools unless you need full source snippets

### Tool Selection Quick Reference

| Task Type | Primary Tools | Graph Tools? |
|-----------|---------------|--------------|
| UI component fix | grep → read → edit | ❌ No |
| Simple feature | grep → read → edit | ❌ No |
| Test addition | read similar test → write | ❌ No |
| Refactoring | graph tools first | ✅ Yes |
| Complex bug fix | graph tools first | ✅ Yes |
| API change | graph tools first | ✅ Yes |
| Multi-file change (5+) | graph tools first | ✅ Yes |
