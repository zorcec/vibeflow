---
"@vibeflow-tools/cli": minor
---

**Breaking, on both surfaces: "no work available" is a success, and the MCP payload says `notices`.**

### An empty board is a success — and both surfaces now say so the same way

The two surfaces disagreed about the identical situation. `vibeflow tasks --next --json` on an empty
board printed the sentence `No todo tasks found. Nothing to work on.` to stdout and exited 0 — a
success with no envelope, so a consumer had to match on prose. MCP's `claim_next_task` answered the
same board with `ok:false` and `NO_TASKS_AVAILABLE`. One situation, two exit meanings.

Both are now a success, and they answer identically:

- `tasks --next --json` on an empty board writes `{ok:true, task:null, next_actions:[]}` to **stdout**,
  writes **nothing** to stderr, and exits **0**. The key set is the successful claim's own key set, so
  `task === null` is the branch — a claimed task is always an object.
- A valid filter that matched no todo task (`--type Bug`, `--user`, `--tag`) is the **same situation**
  and now gets the same payload on both surfaces. It was never a special case on the CLI, and it is
  not one on MCP either.
- `claim_next_task` returns `ok` with a payload of **`null`** instead of an error envelope. A claim's
  payload is the `Task` itself, so an object means claimed and `null` means there was nothing to
  claim. The `dryRun` preview returns the same thing, so a preview cannot disagree with the real call.
- **The `NO_TASKS_AVAILABLE` code is gone.** A filter that matched no task already reached the same
  branch as an empty board, so it was never a separate situation to report a different code for; the
  CLI has no such distinction either, and the surfaces must not grow one. A board whose only todo
  tasks are children is likewise a success, not a refusal.

Non-`--json` output is unchanged: without `--json` the sentence and exit 0 remain exactly as before.
This **reverses** an earlier ruling that pinned the sentence on stdout, so any consumer that was
matching on it must read `task` instead. The stdout-purity sweep in
`tests/e2e/tasks-json-refusals.test.ts` — under `--json`, stdout is empty or exactly one JSON
document — now has **zero** exceptions; its named-exception list and provenance check are kept for
the next ruling that needs them.

### The MCP wire field for partial success is `notices`, an array of objects

The CLI emits `notices: [{code, message}]`. MCP called the same concept `steps`, and as a bare string
array — `["Dry run: task would be updated"]` — so one parser could not read both: a consumer
branching on `payload.steps[0].code` got `undefined` on one surface and a property lookup on a string
on the other.

- The MCP wire key is now **`notices`**, and every entry is a `{code, message}` **object**, the same
  name and the same shape the CLI uses.
- Every dry-run preview is converted, so none of them emits a bare string: `create_task`, `update_task`,
  `claim_next_task`, `add_comment`, `attach_file`, `verify_task` each carry
  `{code:"DRY_RUN", message:"Task would be updated"}` (or the matching phrase), and `push_tasks`
  carries its own `notices` array. The review auto-commit report now speaks the CLI's vocabulary —
  `GIT_COMMITTED` / `GIT_COMMIT_FAILED`, the code the CLI already puts on `notices[].code` for that
  exact situation.
- The `steps` key no longer appears on this surface at any depth, including nested inside the
  `push_tasks` payload, where a second `steps` string array used to hide.
- `OperationResult.steps` in `core/operations.ts` keeps its name — only the key that reaches a client
  changed.
- The online board's `warning` passthrough is **not** part of this and is unchanged: it is a
  server-provided **string** on the SaaS `--edit` payload, and it still does.

`minor`, not `major`, following this repo's 0.x convention: both are breaking reshapes of a
documented payload, and `minor` is what the earlier breaking `--json` reshape shipped as.
