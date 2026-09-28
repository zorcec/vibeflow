---
"@vibeflow-tools/cli": minor
---

**Every refusal now says how to correct it, and three MCP tools that wrote to tasks that did not exist refuse instead.**

### Three tools mutated state for a task that was not there

`add_comment` on an unknown id **created a task file** — a ghost task with `title:"Untitled"`,
`selector:"/"`, `status:"todo"`, carrying the comment — and answered `ok:true` with a comment id.
`attach_file` on an unknown id **wrote a file** under `.vibeflow/tasks/files/<id>/` and answered
`ok:true` with a URL for a file belonging to a task that does not exist. Both told the agent the write
happened, so there was nothing to recover from and the board gained tasks nobody created. The CLI
refused the same calls with `TASK_NOT_FOUND`.

One shared resolver — `resolveTaskOrRefusal` in `src/core/operations.ts` — now decides what an id
means before any task-scoped tool touches state, and every mutating tool writes the *resolved* id. A
new e2e guard (`tests/e2e/mcp-task-existence-guard.test.ts`) derives the swept tool set from the
manifest, calls each with an id that cannot exist, and asserts both that it refuses **and** that the
tree under `.vibeflow/tasks` is unchanged — so a future task-scoped tool is covered the day it lands.

A fourth defect, found while fixing the third: `buildUpdateLinks` dropped the producer's refusal code,
so a `parent`/`relates`/`blocks` link targeting a task that does not exist refused as a generic
`UPDATE_TASK_ERROR` — telling the client the *call* was wrong when the truth was "that task does not
exist". It now reports `TASK_NOT_FOUND` (or the producer's real code), with the same recovery text as
every other `TASK_NOT_FOUND`.

### A refusal with no `suggestion` is not a refusal an agent can act on

A code names which rule fired and leaves the agent guessing which input to change. Nineteen of the
twenty-five error returns in `operations.ts` carried no `suggestion` at all, and `TASK_NOT_FOUND`
carried *two different* texts depending on which tool returned it. Now:

- `TASK_NOT_FOUND` carries one identical suggestion on every tool that returns it.
- The shared review-gate suggestions (`VERIFY_REQUIRED`, `VERIFY_REASON_REQUIRED`,
  `COMMIT_MESSAGE_REQUIRED`, `BRANCH_REQUIRED`, `REVIEW_COMMENT_REQUIRED`, both
  `VERIFY_FAILED_ATTESTED` refusals, `RESEARCH_VERIFY_NOT_ALLOWED`) name the **MCP input and the CLI
  flag**. The same string is read by the CLI and by MCP `update_task`, so a CLI-only suggestion
  was an answer an MCP client could not use. (The HTTP `PATCH` route is not a reader of this gate —
  it enforces the research rule inline — so it is not named here.)
- `VerifyAttestationResolution` and `FileValidationResult` gained a `suggestion` field, because those
  two producers are the only place that knows why an input was refused and what a valid one is —
  without the field their callers had nothing to forward.
- All twelve generic `catch` wrappers (`LIST_TASKS_ERROR` … `PUSH_TASKS_ERROR`, `UNSUPPORTED_FILE_TYPE`,
  `E_NO_BASELINE`) now say what to try instead of only naming the exception.

### Schema errors arrive outside our vocabulary, and the README says so

An input the tool's own schema rejects is refused by the **MCP SDK's input validation, before any
vibeflow handler runs** — so this class has no vibeflow code and no `suggestion`, and vibeflow does
not pretend otherwise. What arrives is `result.isError === true` with
`MCP error -32602: Input validation error: … at <field>`, and the offending field is named. Because
the code string is client-dependent (some clients normalise it into a label of their own), the README
tells consumers to **recognise the class by its shape, not by a code string**.

The one honest lever left: `tools/list` is the only place a client can read the contract before it
fails, so the input shapes now publish a `description` for every field an agent commonly gets wrong —
`id` on each task tool, the `setVerify`/`verifyReason` pair, `limit`, `contentB64`, the comment body
and `filename`.
