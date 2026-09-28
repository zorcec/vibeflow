---
"@vibeflow-tools/cli": minor
---

**Every refusal now says how to correct it, and three MCP tools that wrote to tasks that did not exist refuse instead.**

### Breaking for MCP consumers

Two of these change what a call ANSWERS, not just how it explains itself, so a consumer that
branches on `ok` or on a code has to be updated. Hence `minor` (0.x semver).

- **`add_comment` and `attach_file` no longer return `ok:true` for an id that does not exist.** Both
  used to create state for a task that was not there (a ghost task file, and a file under
  `.vibeflow/tasks/files/<id>/`) and report success. They now return
  `{"ok":false,"error":{"code":"TASK_NOT_FOUND",…}}` and write nothing. A client that relied on
  `add_comment` creating the task it names has to create it first.
- **A `parent` / `relates` / `blocks` link naming a task that does not exist is re-coded.** It used
  to refuse as a generic `UPDATE_TASK_ERROR`; it is now `TASK_NOT_FOUND`, with the same recovery text
  as every other `TASK_NOT_FOUND`. Branch on `TASK_NOT_FOUND`, not on `UPDATE_TASK_ERROR`.
- **`verify_task` now accepts an id PREFIX**, like every other task tool (its own `dryRun` preview
  already did — the two disagreed). The engine's codes are unchanged: an id that resolves to nothing
  is still `E_NOT_FOUND`.

The rest of this release is additive: a `suggestion` on refusals that had none, one text per code,
and input `description`s. A consumer that only reads `code` is unaffected by those.

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
tree under `.vibeflow/tasks` is unchanged **path by path and byte by byte** (every file is compared
by content digest, so a rewritten file fails too) — so a future task-scoped tool is covered the day
it lands. The same sweep asserts the cross-tool property this release exists for: **one code carries
one `suggestion` wherever it appears**. It found a second live instance while being written —
`VERIFY_REASON_REQUIRED` had one text from the attestation and another from the gate; both now return
the single `VERIFY_REASON_REQUIRED_SUGGESTION`.

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
- `verify_task` returns the CLI verify engine's own codes, several of which carry no text of their own
  (`E_NO_SELECTOR`, `E_AUTH_EXPIRED`, `E_APP_NOT_RUNNING`, …). The tool substitutes one fallback
  recovery line where the engine has none. **No engine code is renamed.**
- The CLI's human output now prints the attestation refusal's `suggestion`; previously only the
  `--json` envelope carried it, so a human agent got the rule with nowhere to put the reason.
- `RESEARCH_VERIFY_NOT_ALLOWED` is defined once (`RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL` in
  `src/core/review-gate.ts`) and read by all three of its producers — the gate, the CLI's standalone
  `--set-verify` check, and that check's human printer — instead of being copied out three times.

### Schema errors arrive outside our vocabulary, and the README says so

An input the tool's own schema rejects is refused by the **MCP SDK's input validation, before any
vibeflow handler runs** — so this class has no vibeflow code and no `suggestion`, and vibeflow does
not pretend otherwise. What arrives is `result.isError === true` with
`MCP error -32602: Input validation error: … at <field>`, and the offending field is named. Because
the code string is client-dependent (some clients normalise it into a label of their own), the README
tells consumers to **recognise the class by its shape, not by a code string**.

An **unknown tool** arrives the same way and with the same `-32602` — the SDK routes it through the
same input-validation path — but it names the *tool*, not a field, so it is documented as a separate
case with its own remedy rather than folded into a class whose own recognition rule would not match
it. (JSON-RPC reserves `-32601` for "method not found"; the SDK does not use it here, and the e2e
suite pins what actually arrives.)

The one honest lever left: `tools/list` is the only place a client can read the contract before it
fails, so the input shapes now publish a `description` for every field an agent commonly gets wrong —
`id` on each task tool (a full id or a unique prefix — `export_prompt` matches ids exactly and says
so), the `setVerify`/`verifyReason` pair, `limit`, `contentB64`, the comment body
and `filename`.
