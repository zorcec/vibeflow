# Plan: MCP Server Implementation Fixes

> **Deliverable:** actionable fix plan for the MCP implementation review findings.
> **Repo:** `vibeflow-private` → `packages/cli`
> **Spec:** `docs/specs/mcp-implementation.spec.md`
> **Date:** 2026-09-03 (spec date) · plan authored against current `src/` state
> **Status:** Ready for worker implementation — no open questions.

> **Note on file placement:** this artifact was requested at `docs/specs/mcp-fixes.plan.md`.
> The runtime forced output to this path instead. Content is drop-in — copy as-is.

---

## 0. Evidence base (what was verified in code)

All root causes below were read directly from source, not inferred from the issue list.

| Claim | Evidence |
| --- | --- |
| `src/mcp/http.ts` has a module-scope `setInterval` with no `.unref()` and no stored handle | `http.ts` lines after `const SESSION_TTL`: `setInterval(() => {...}, 5 * 60 * 1000)` at top level |
| Every CLI invocation evaluates that module body | `src/index.ts:3` `import { serve } from "./server/server.js"` → `src/server/server.ts` `import { mountMcp } from "../mcp/http.js"` (static, top-level) |
| `tasks` action is sync + fire-and-forget async IIFE | `src/index.ts`, `program.command("tasks")...action((dir, opts) => { void (async () => { ... })(); })` |
| `flushTelemetry()` is called on only **one** of ~10 `tasks` exit paths | only at the end of the human list path (`await flushTelemetry()` immediately before `})();`); `--get`, `--next`, `--add`, `--commit`, `--edit`, JSON list, `filtered.length === 0`, and every `outputError` path return early |
| PostHog client is created lazily by `capture()` at the top of every action | `src/telemetry.ts`: `getClient()` → `new PostHog(..., { flushAt: 1, flushInterval: 0 })`; `flushTelemetry()` → `client.shutdown()` |
| CLI `--add` drops `tags`, `type`, `priority` | `src/index.ts` Add mode: `createTask(projectDir, { title, description: ..., status, selector: "/" })` — no `tags`, no `type`, no `priority` |
| `--priority` does not exist as a CLI flag at all | `tasks` option list has `--status --type --user --edit --add --title --set-status --description --json --commit --task --message --comment --commit-message --get --next --tag --report-file --branch --skip-verify --limit --dry-run --fields` |
| Core *does* support tags, so Fix 3 is purely additive | `src/core/tasks.ts`: `createTask(projectDir, input: Omit<Task, "id"\|"created"\|"comments"\|"files">)`; `normalizeTask` round-trips `tags` and `priority` |
| SaaS schema has **no** `tags` field | `src/saas/client.ts`: `interface SaasTask { ... priority, type, boardId, branchName, comments, files }` — no `tags` |
| `verify_task` MCP op is structurally broken | `src/mcp/operations.ts` `verifyTaskOp` calls `runVerify(...)` which is declared `Promise<void>` and `console.log`s its output → `OperationResult.data === undefined` → `formatResult` builds `{ type:"text", text: JSON.stringify(undefined) }` (`text` becomes `undefined`) |
| A Playwright-mocking pattern for verify already exists in-repo (no browser needed) | `tests/unit/commands/verify.test.ts`: `vi.mock("playwright", () => ({ chromium: { launch: vi.fn().mockResolvedValue(mockBrowser) } }))` plus mocks for `core/tasks.js`, `core/files.js`, `core/comments.js` |
| `verify_task` / `push_tasks` are absent from MCP tool tests | `tests/unit/mcp/tools.test.ts` imports only `listTasks, getTask, createTask, updateTask, claimNextTask, addComment, attachFile, exportPrompt` |
| The verify gate lives **only** in `index.ts` | gate block `if (opts.setStatus === "review" && settings.requireVerifyBeforeReview && !opts.skipVerify)` is inline in the local edit path; `src/mcp/operations.ts` `updateTask` has no reference to `settings`, `verified`, `skipVerify`, or `commitMessage` |
| `verified` is only ever set to `true`, never `false`, by verify | `src/commands/verify.ts`: `if (result.ok) { updateTask(absProjectDir, taskId, { verified: true }); }` |
| CLI resets `verified` on re-claim, MCP does not | `index.ts`: `if (opts.setStatus === "in-progress") { updates.verified = false; }`; MCP `updateTask` builds `updates` from `status/title/description/branchName` only |
| No MCP/`core` `operations.ts` exists yet | `src/core/operations.ts` → ENOENT; ops live in `src/mcp/operations.ts` |
| `schema.ts` / `adapters.ts` from the spec were never created | both ENOENT; `McpServer.tool()` registers raw zod shapes directly in `src/mcp/server.ts` |

---

## Fix 1 — CLI hangs after task operations (CRITICAL)

### 1.1 Root cause analysis

There are **three** independent handles keeping the event loop alive. Fix all three; the first is the one that makes the hang *indefinite*.

**RC-A (fatal, indefinite hang): module-scope `setInterval` in `src/mcp/http.ts`.**

```ts
// src/mcp/http.ts — top level, runs on import
const SESSION_TTL = 30 * 60 * 1000;
setInterval(() => { /* reap stale sessions */ }, 5 * 60 * 1000);
```

`src/index.ts` statically imports `./server/server.js`, which statically imports `../mcp/http.js`. Module bodies execute at import time, so `vibeflow tasks --add ...` starts a **ref'd** 5-minute timer even though it never mounts Express. A ref'd timer is a permanent handle: Node's exit condition (empty event loop) is never met, so the process prints its output and then hangs forever until killed. This matches the reported symptom exactly (hang *after* the operation completes, "Medium" severity, MCP clients timing out) and it was introduced by the MCP work — which is why it wasn't seen before.

Reference for the mechanism and the identical class of bug in other CLIs: [Node.js timers docs — `unref()`](http://nodejs.org/api/timers.html), [ruvnet/ruflo #1256 — `setInterval` without `.unref()` prevents CLI exit](https://github.com/ruvnet/ruflo/issues/1256), [openclaw PR #35645 — `unref` tick interval so CLI commands can exit](https://github.com/openclaw/openclaw/pull/35645).

**RC-B (up to ~10s stall): PostHog client never shut down.**

`capture("command_run", ...)` runs at the top of every `tasks` sub-mode and lazily constructs a `PostHog` client with `flushAt: 1` → each capture fires an immediate HTTP flush to `eu.i.posthog.com`. Teardown is `flushTelemetry()` → `await client.shutdown()`, but that call exists only on the *last* statement of the human list path. Every other path (`--add`, `--edit`, `--next`, `--get`, `--commit`, `--json` list, "no tasks found", all error returns) exits without shutdown, leaving a pending request + keep-alive socket. Official guidance: *"Call `shutdown()` once before the process exits to ensure that all events have been sent and all promises have resolved."* On a blocked/proxied network the pending fetch stalls until its timeout (default ~10s). [PostHog Node.js reference](https://posthog.com/docs/references/posthog-node), [known "Timed out while shutting down PostHog" reports](https://github.com/PostHog/posthog-js/issues/2854).

**RC-C (minor, SaaS mode): `void maybeRefreshSettings()`** at `src/index.ts` module scope fires an unawaited `fetch()` to `app.vibeflow.tools/api/cli/settings` when a token exists (and settings are >5 min stale). Same class of orphan-handle stall.

**Contributing structural defect:** the `tasks` `.action()` handler is **synchronous** and wraps its body in `void (async () => {...})()`. `program.parse()` returns immediately, so there is no seam to sequence teardown — a `finally { await flushTelemetry() }` cannot be added without making the action async.

### 1.2 Fix approach

**Step 1.2.1 — Make the session reaper own its lifecycle (`src/mcp/http.ts`).**

Replace the top-level interval with a lazily-created, unref'd handle, and register signal handlers once:

```ts
let reaper: NodeJS.Timeout | null = null;
let handlersRegistered = false;

function startSessionReaper(): void {
  if (reaper) return;
  reaper = setInterval(reapStaleSessions, 5 * 60 * 1000);
  // Do not keep one-shot CLI processes alive.
  reaper.unref();
}

function reapStaleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) {
      session.transport.close().catch(() => {});
      sessions.delete(id);
    }
  }
}
```

- Call `startSessionReaper()` **inside `mountMcp()`** (first line), not at module scope.
- Keep `.unref()` even after the move — `serve` stays alive through its HTTP/WS servers, and unit/e2e tests that call `mountMcp()` must not hang Vitest.
- Hoist the `process.on("SIGTERM"|"SIGINT", cleanup)` registrations out of `mountMcp()` behind the `handlersRegistered` guard (currently a new listener is added on every mount → `MaxListenersExceededWarning` when tests mount repeatedly across the 4–8 fork pool). Expose `stopMcpForTests()` (clear `reaper`, `clearSessions()`, reset flag) for test teardown.
- Do **not** remove the `setInterval` behaviour itself — session TTL reaping is still required for `serve`.

**Step 1.2.2 — Guarantee telemetry teardown on every path (`src/index.ts`, `src/telemetry.ts`).**

1. Convert the `tasks` action to `async` and wrap the existing body (keep the inner function, change only the wrapper — minimal diff):

```ts
.action(async (dir: string, opts: { ... }) => {
  const taskSubcommand = ...;
  capture("command_run", { command: "tasks", subcommand: taskSubcommand });
  try {
    await runTasksCommand(dir, opts);   // existing body, unchanged returns
  } finally {
    await flushTelemetry();             // runs on ALL paths incl. throws
  }
})
```

   Extracting the body into a module-level `runTasksCommand()` is preferred (it makes the 2812-line file testable), but a straight `try/finally` around the IIFE body is acceptable if the worker wants a smaller diff.
2. Apply the same `try/finally { await flushTelemetry() }` to every other one-shot command action that calls `capture()` (`serve`, `kanban`, `verify`, `push`, `watch`, `auth`, `changelog`, `telemetry`, `login`, `logout`, `status`) — several call `flushTelemetry()` *before* the work instead of after (`await flushTelemetry(); await login();`), which is wrong ordering: it flushes an empty queue and then captures an event that is never shut down. Move those calls into a `finally`.
3. Bound the teardown so a blackholed network cannot stall the CLI:

```ts
export async function flushTelemetry(): Promise<void> {
  if (!client) return;
  const active = client;
  client = null;                 // idempotent: second call is a no-op
  try {
    await active.shutdown({ timeout: 2_000 });
  } catch { /* never block the CLI */ }
}
```

1. Add a belt-and-braces exit guard **for one-shot commands only**, so any future top-level handle cannot reintroduce an indefinite hang. In `src/index.ts`, after `program.parseAsync()` (switch `program.parse()` → `await program.parseAsync()` so the action's completion is observable):

```ts
await program.parseAsync();
if (!KEEP_ALIVE_COMMANDS.has(activeCommandName)) {
  // One-shot command: output is flushed, telemetry is shut down. Do not linger.
  process.exit(process.exitCode ?? ExitCode.OK);
}
```

`KEEP_ALIVE_COMMANDS = new Set(["serve", "kanban", "watch"])`. Capture the invoked command name via `program.commands`/a `preAction` hook. This guard is a safety net, **not** a substitute for 1.2.1/1.2.2 — if it is the only thing applied, `stdout` piping races remain (stdout to a pipe is synchronous in Node, so `process.exit` after `await`ing the action is safe).

**Step 1.2.3 — Neutralise the module-scope settings refresh.** Keep `void maybeRefreshSettings()` but give the underlying request a timeout and make it unref-able is not possible for `fetch`; instead gate the call so it only fires for commands that need SaaS settings at startup, and `await` it (max 1.5s race) inside the `tasks` action for `mode === "saas"`. Minimal acceptable version: wrap in `try` and export the promise so the `finally` can await it — `let settingsRefresh: Promise<void> | null` in `index.ts`, awaited in the same `finally` as `flushTelemetry()`.

### 1.3 Acceptance criteria

- [ ] `node dist/cli/index.js tasks --json --status todo` exits on its own. Measured by a **new spawn test** `tests/e2e/cli-exit.test.ts` (config already exists: `vitest.e2e.config.ts`, `testTimeout: 30_000`):

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const CLI = new URL("../../dist/cli/index.js", import.meta.url).pathname;

const CASES: string[][] = [
  ["tasks", "--json"],
  ["tasks", "--status", "todo", "--json"],
  ["tasks", "--add", "--title", "exit-probe", "--json"],
  ["tasks", "--get", "deadbeef", "--json"],
  ["tasks", "--edit", "deadbeef", "--set-status", "review", "--json"], // error path
];

for (const args of CASES) {
  it(`exits within 3s: vibeflow ${args.join(" ")}`, async () => {
    const started = Date.now();
    await execFileAsync(process.execPath, [CLI, ...args], {
      env: { ...process.env, VIBEFLOW_TELEMETRY: "0" },
      timeout: 3_000, // promisify rejects with ETIMEDOUT if it hangs
    });
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);
}
```

  Run the same cases a second time with `VIBEFLOW_TELEMETRY` unset to prove RC-B is fixed too. Use a temp `HOME` (`env: { HOME: tmp }`) so the real `~/.vibeflow/config.json` is untouched and telemetry writes are isolated.

- [ ] `grep -n "setInterval" packages/cli/src/mcp/*.ts` → the only occurrence is inside `startSessionReaper()`, with `.unref()` on the next line.
- [ ] `flushTelemetry` appears exactly once per command action, inside a `finally` block.
- [ ] `serve` regression: `pnpm dev` → `vibeflow serve` still runs indefinitely, `/api/mcp` initialises a session, and the reaper still runs (assert via `vi.useFakeTimers()` unit test in `tests/unit/mcp/http.test.ts`: mount → `vi.advanceTimersByTime(31*60*1000)` → `getSessionCount() === 0`). Existing exports `getSessionCount()` / `clearSessions()` are already test hooks.
- [ ] `pnpm --filter @vibeflow-tools/cli run test` and `test:e2e` green; `pnpm check` (`tsc --noEmit`) clean.
- [ ] Manual: `time node dist/cli/index.js tasks --add --title x --json` → `real < 0.5s`.

---

## Fix 2 — Operations layer belongs in `src/core/`, not `src/mcp/`

### 2.1 Problem

Spec §1/§2 mandate `packages/cli/src/core/operations.ts` as the shared layer with **MCP and CLI as siblings calling into it** ("Key property: MCP and CLI are siblings, not parent/child"). Implementation put it in `src/mcp/operations.ts`, so `src/index.ts` cannot import it without reaching into the MCP subsystem. Consequence already observed: the review-gate policy, auto-commit, `verified` reset, Research-report enforcement and required-comment validation are duplicated in `index.ts` only, and the MCP `update_task` path silently bypasses **all** of them (see §0 and Fix 2.4).

### 2.2 Migration plan (mechanical, behaviour-preserving)

**Step 2.2.1 — Move the file.** `git mv packages/cli/src/mcp/operations.ts packages/cli/src/core/operations.ts`. No shim/re-export — the only importers are internal (listed below), so a single commit is atomic.

**Step 2.2.2 — Rewrite the file's own import specifiers** (it currently uses `../core/*` relative paths that must become `./`):

| Current | After move |
| --- | --- |
| `import type { Task, TaskComment } from "../core/types.js"` | `"./types.js"` |
| `import type { FileInfo } from "../core/files.js"` | `"./files.js"` |
| `await import("../core/tasks.js")` | `await import("./tasks.js")` |
| `await import("../core/comments.js")` | `await import("./comments.js")` |
| `await import("../core/files.js")` | `await import("./files.js")` |
| `await import("../commands/verify.js")` | `await import("../commands/verify.js")` (unchanged) |
| `await import("../commands/push.js")` | `await import("../commands/push.js")` (unchanged) |

**Step 2.2.3 — Update the three importers.**

| File | Change |
| --- | --- |
| `src/mcp/manifest.ts` | `from "./operations.js"` → `from "../core/operations.js"` (2 import statements: types + values) |
| `src/mcp/server.ts` | `from "./operations.js"` → `from "../core/operations.js"` |
| `tests/unit/mcp/tools.test.ts` | `from "../../../src/mcp/operations.js"` → `from "../../../src/core/operations.js"` |

**Step 2.2.4 — Layering caveat (deliberate decision, record it in the file header).** `src/core/operations.ts` importing `src/commands/verify.js` and `src/commands/push.js` inverts the existing `commands → core` direction. It is acceptable **because both calls are dynamic `await import()`**, which keeps the static graph acyclic and defers loading Playwright/express code until a tool actually needs it. Add a header comment stating this, plus a TODO: *extract `runVerify`'s CLI-shell concerns (chalk printing, `process.exitCode`, comment writing) so `core/` depends only on `core/`.* Do not attempt that extraction in this PR.

**Step 2.2.5 — Guard the layering so it cannot rot.** Extend `tests/unit/mcp/drift.test.ts` with structural assertions (cheap, no new tooling):

```ts
it("operations layer lives in core, not mcp (spec §1)", async () => {
  expect(existsSync(join(pkgRoot, "src/core/operations.ts"))).toBe(true);
  expect(existsSync(join(pkgRoot, "src/mcp/operations.ts"))).toBe(false);
});

it("mcp modules do not implement task logic themselves", () => {
  for (const f of ["manifest.ts", "server.ts", "http.ts", "auth.ts"]) {
    const src = readFileSync(join(pkgRoot, "src/mcp", f), "utf-8");
    expect(src).not.toMatch(/writeFileSync|mkdirSync\(|\.vibeflow/);
  }
});
```

### 2.3 Step 2 — make the CLI actually consume the shared layer

Moving the file is necessary but not sufficient; the spec's point is one implementation per operation. The full `index.ts` refactor is large, so **do it incrementally, in this order**, driven by the fixes below:

1. `--add` → delegate to `createTask(ctx, input)` (lands together with Fix 3 — the two surfaces then cannot disagree about which fields are persisted).
2. `--edit` → delegate to `updateTask(ctx, input)` **after** the review-gate/auto-commit/Research/comment policy is lifted out of `index.ts` into `core/operations.ts` (Fix 2.4).
3. `--next`, `--get`, list, `--commit` → leave on the current inline code in this PR. They have heavy human-formatting branches; migrating them is a separate, formatting-sensitive task. Record as follow-up.

Delegation must not change CLI output. `index.ts` owns chalk rendering; operations own the data mutation + validation. Pattern: `const res = await coreCreateTask(ctx, {...}); if (!res.ok) { outputError({...res.error, json: opts.json}); process.exitCode = ExitCode.USAGE; return; } printCreated(res.data)`.

### 2.4 In-scope because it is the reason the layer is shared: MCP `update_task` bypasses every review policy

`src/core/operations.ts` `updateTask` currently applies only `status | title | description | branchName` + an optional comment. Missing vs `index.ts` and spec §5.4:

| Policy | CLI (`index.ts`) | MCP op |
| --- | --- | --- |
| `--comment` required for `review` | ✅ | ❌ |
| `requireVerifyBeforeReview` gate (UI tasks need `verified`) | ✅ | ❌ |
| `skipVerify` escape hatch honoured | ✅ | ❌ (field parsed, never read) |
| `autoCommit` → `commitMessage` required + `git commit` + link SHA | ✅ | ❌ (field parsed, never read) |
| `autoPush` after commit | ✅ | ❌ |
| `autoComment` / `createBranch` required-flag checks | ✅ | ❌ |
| Research task needs attached `.md` before `review` | ✅ | ❌ |
| `verified: false` reset on `in-progress` | ✅ | ❌ |
| "agents must not set done" warning | ✅ | ❌ |

**Fix:** extract the whole review-transition block from `index.ts` into `core/operations.ts` as the single `updateTask` implementation (context carries `dryRun`, `settings` are loaded from `ctx.projectDir` via `loadSettings`), then have `index.ts` call it. Return policy failures as `OperationResult.error` with codes `E_COMMENT_REQUIRED`, `E_VERIFY_REQUIRED`, `E_COMMIT_MESSAGE_REQUIRED`, `E_BRANCH_REQUIRED`, `E_RESEARCH_REPORT_REQUIRED`; `index.ts` maps them to `outputError` + `ExitCode.USAGE`, MCP returns them as tool errors. This is the highest-value architectural fix in the PR and must be done before Fix 4's `verified` change (both touch the same transition).

### 2.5 Acceptance criteria

- [ ] `src/core/operations.ts` exists; `src/mcp/operations.ts` deleted (no shim).
- [ ] `pnpm check` clean; `pnpm test` green with the same case count as before the move (no test logic changed, only import paths).
- [ ] New structural tests from 2.2.5 pass; and **fail** if `src/mcp/operations.ts` is re-added (verify by temporarily creating the file).
- [ ] Parity test `tests/unit/mcp/parity.test.ts` asserting CLI and MCP produce identical results for the same operation, for both the happy path and each gate above:

```ts
// CLI path
const cliOut = await execFileAsync(process.execPath,
  [CLI, tmpDir, "--add", "--title", "T", "--json"]);
// MCP path
const mcpOut = await createTask({ projectDir: tmpDir, mode: "local" }, { title: "T" });
// then compare the persisted task.json byte-for-byte (minus id/created)
```

- [ ] `update_task` with `{status:"review"}` on an unverified UI task returns `{ok:false, error:{code:"E_VERIFY_REQUIRED"}}` **and** the equivalent CLI invocation exits non-zero with the same code — i.e. the gate can no longer be bypassed via MCP.
- [ ] `update_task` with `{status:"in-progress"}` sets `verified: false` in the task file.

---

## Fix 3 — Tags not supported on `create_task` (`tasks --add`)

### 3.1 Problem

`--tag` is declared as a repeatable collector (`(val, prev) => [...prev, val]`, default `[]`) and is consumed by the list, `--next` and `--edit`-usage paths, but **Add mode never reads `opts.tag`**. `--type` in Add mode is likewise ignored (it is only applied as a filter), and `--priority` is not a flag at all. Meanwhile `core.createTask` supports all three and the MCP `create_task` tool exposes `tags`, `type`, `priority`, `url`, `selector`, `cssSelector`. Net effect: `vibeflow tasks --add --title X --tag urgent` succeeds and silently produces an **untagged** task, so `--tag urgent` then returns nothing — the agent concludes tags are broken. The drift test cannot catch this: it only asserts that each manifest `cliRef.flag` *exists on the command*, not that Add mode consumes it.

### 3.2 Fix approach

**Step 3.2.1 — New/updated flags on `tasks` (in `src/index.ts`):**

- `--priority <priority>` — new. `"Critical | High | Medium | Low"`.
- `--type <type>` — existing; now **dual meaning**: filter in list/`--next` mode, value in `--add` mode. Filters are meaningless when creating, so overloading is safe; state it in the help text: `"Filter by type (list/next) or set type (--add)"`.
- `--tag <tag>` — existing; now also applied in `--add` mode. Keep the collector.

**Step 3.2.2 — Validation in Add mode (before any write), each returning `ExitCode.USAGE` via `outputError`:**

```ts
const ADD_STATUSES = VALID_STATUSES;                      // already used
const VALID_PRIORITIES = ["Critical", "High", "Medium", "Low"] as const;
const VALID_ADD_TYPES  = ["Task", "Bug", "Feature", "Enhancement", "Research"];

if (opts.priority && !VALID_PRIORITIES.some(p => p.toLowerCase() === opts.priority!.toLowerCase())) {
  outputError({ code: "E_USAGE", message: `Invalid priority: "${opts.priority}"`,
    suggestion: `Valid priorities: ${VALID_PRIORITIES.join(" | ")}`, json: opts.json });
  process.exitCode = ExitCode.USAGE; return;
}
if (opts.tag?.some(t => !t.trim())) { /* E_USAGE: empty tag */ }
```

Reject invalid values explicitly rather than relying on `core.createTask`'s silent normalisation (it lowercases and defaults unknown priorities to `"Medium"`, which would hide typos). Canonicalise to the exact enum casing before calling core.

> **Known inconsistency to note, not to fix here:** `VALID_TASK_TYPES` (used by `normalizeTaskType` for display) is `["Task","Bug","Research"]` while `VALID_FILTER_TYPES` (used for `--type` filter validation) is the 5-value set. `--add --type Feature` will therefore persist `Feature` but render no `type:` line. Aligning these sets is a follow-up; for this fix accept the 5-value set in Add mode so `--add` and the MCP tool agree.

**Step 3.2.3 — Local Add path:** pass the fields through.

```ts
const created = createTask(projectDir, {
  title: opts.title.trim(),
  description: opts.description?.trim() ?? "",
  status,
  selector: "/",
  ...(opts.type ? { type: canonicalType } : {}),
  ...(opts.priority ? { priority: canonicalPriority } : {}),
  ...(opts.tag?.length ? { tags: canonicalTags } : {}),
});
```

Use `...(cond ? {k:v} : {})` rather than unconditional keys: `normalizeTask` treats `tags: []` as `undefined` but `writeTaskJson` writes whatever object it is given, and omitting absent fields keeps the emitted `task.json` byte-identical to pre-fix output for existing invocations (important for the mutation suite and any golden-file tests).

**Step 3.2.4 — Dry-run Add path:** include `type`, `priority`, `tags` in the `dryTask` preview object (both local and SaaS dry-run) so `--dry-run --json` is a faithful preview.

**Step 3.2.5 — Output echo:** in both human and JSON Add output, print the persisted fields so the caller can confirm the write:

```
✓ Task created: Fix CTA spacing
  id: abc… | status: todo | type: Bug | priority: High | tags: urgent, frontend
```

JSON mode needs no change (`created` already includes the persisted fields once 3.2.3 lands).

**Step 3.2.6 — SaaS mode: explicitly out of scope, must not fail silently.** `SaasTask`/`createSaasTask` carry no `tags`, so `--add --tag x` in online mode cannot work. Add a warning and keep going:

```ts
if (opts.tag?.length) {
  console.log(chalk.yellow("⚠  Tags are not supported in online mode; the task was created without tags."));
}
```

Follow-up ticket: add `tags` to the SaaS schema. Do **not** exit non-zero here — `--tag` filtering legitimately works in SaaS mode and the task creation itself succeeds.

**Step 3.2.7 — Agent-facing docs.** Update the `Create:` line in `renderAgentInstructions` (`src/core/tasks.ts`) and the `add` dry-run suggestion to mention `--type --priority --tag`. Update the `program.addHelpText("after", ...)` quick reference in `index.ts` similarly, otherwise agents keep hitting the old behaviour.

**Step 3.2.8 — MCP parity.** `createTask` op already forwards `tags`/`type`/`priority` — no change required, but it must be re-verified after Fix 2.3 hands `--add` to the same function. Add the `--priority`/`--type` flags to `manifest.ts`'s `create_task.cliRef.flags` (currently `["--add","--title","--description","--type","--priority","--tag"]` — already correct once 3.2.1 lands; today it is aspirational and the drift test passes only because `--type`/`--tag` exist as filters and `--priority` **is absent**, which means the drift test as written *should* already fail for `--priority`. Confirm by running it; if it fails, that is proof the drift test works and 3.2.1 closes it. If it passes, the third drift assertion ("every cliRef refers to existing command/flag") was never implemented — the current `drift.test.ts` has only field-presence/uniqueness checks, so **it was not implemented**; add it as part of this fix.)

### 3.3 Acceptance criteria

- [ ] `vibeflow tasks <dir> --add --title "T" --description "D" --tag urgent --tag frontend --type Bug --priority High --json` → `jq .task` has `tags == ["urgent","frontend"]`, `type == "Bug"`, `priority == "High"`.
- [ ] Round-trip: `.vibeflow/tasks/<date>/<id>.json` on disk contains the same three fields; `vibeflow tasks --tag urgent --json` returns the task; `--tag urgent --tag nonexistent` returns nothing (AND semantics preserved).
- [ ] `vibeflow tasks --get <id>` shows the type/priority lines (display path already supports them).
- [ ] Regression guard: `vibeflow tasks <dir> --add --title "T" --json` (no new flags) writes a `task.json` **identical** in key set to the pre-fix output — assert `!Object.hasOwn(task, "tags")`.
- [ ] Invalid `--priority Urgent` → exit `USAGE`, error mentions valid list, **no task file created**.
- [ ] `--dry-run --add --tag a --json` preview includes `tags: ["a"]` and writes no file.
- [ ] SaaS mode (`VIBEFLOW_API_URL` pointed at a stub, or a unit test that stubs `getMode`) logs the tags-unsupported warning and still creates the task.
- [ ] New unit test in `tests/unit/core/operations.test.ts` (or `tests/unit/mcp/tools.test.ts`) plus a spawn-level e2e case in `tests/e2e/`.
- [ ] Drift test extended with the unimplemented "every `cliRef` flag exists on the referenced command" assertion, and green.

---

## Fix 4 — `verify_task` is untested (and currently non-functional over MCP)

### 4.1 Problem

1. `tests/unit/mcp/tools.test.ts` covers 8 of 10 ops; `verifyTaskOp` and `pushTasks` are absent.
2. The reason given ("needs Playwright browser") is **not valid**: `tests/unit/commands/verify.test.ts` already drives the full `verifyTask()` engine with `vi.mock("playwright", ...)` and never launches a browser.
3. The blocker is a real defect: `verifyTaskOp` calls **`runVerify`**, the CLI shell, which returns `Promise<void>`, writes its JSON report with `console.log` (into the *server's* stdout, not the MCP response) and mutates `process.exitCode` inside a long-lived server process. So `OperationResult.data` is `undefined`, and `formatResult` emits `{ type: "text", text: JSON.stringify(undefined) }` → `text: undefined`, which violates the MCP `TextContent` contract (`string` required). `verify_task` is therefore broken end-to-end, not merely untested. Its `timeoutMs` input is also never used, and there is no serialisation semaphore (spec §5.9).

### 4.2 Fix approach

**Step 4.2.1 — Reimplement the op against the engine, not the CLI shell** (`src/core/operations.ts` after Fix 2):

```ts
export async function verifyTaskOp(
  ctx: OperationContext,
  input: VerifyTaskInputType,
): Promise<OperationResult<VerifyResult>> {
  return withVerifySemaphore(async () => {
    const { verifyTask, addVerifySystemComment } = await import("../commands/verify.js");
    const timer = setTimeout(...);      // real enforcement of input.timeoutMs
    try {
      const result = await Promise.race([
        verifyTask(ctx.projectDir, input.id, { url: input.url }),
        timeout<VerifyResult>(input.timeoutMs, "VERIFY_TIMEOUT"),
      ]);
      await addVerifySystemComment(ctx.projectDir, input.id, result); // keep §9.2 step 14
      return { ok: true, data: result };
    } catch (err) {
      if (err instanceof VerifyError) {
        return { ok: false, error: { code: err.code, message: err.message, suggestion: err.suggestion } };
      }
      return { ok: false, error: { code: "VERIFY_TASK_ERROR", message: String(err) } };
    } finally { clearTimeout(timer); }
  });
}
```

Required supporting changes in `src/commands/verify.ts`:

- **Export `VerifyError`** (currently module-private) and the `VerifyResult` type (already exported).
- **Extract the system-comment write** out of `runVerify` into `export async function addVerifySystemComment(projectDir, taskId, result)` so the MCP path keeps writing the `**Verification ✅ passed / ⚠️ issues detected**` comment. Without this, moving to `verifyTask()` silently regresses comment behaviour that `tests/unit/commands/verify.test.ts` already asserts.
- `runVerify` stays as-is (CLI shell: chalk output + `process.exitCode`) and now calls `addVerifySystemComment` itself.
- Add a module-level `withVerifySemaphore` (concurrency **1**, per spec §5.9) in `core/operations.ts`. A trivial promise-chain queue is sufficient:

```ts
let tail: Promise<unknown> = Promise.resolve();
function withVerifySemaphore<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
```

**Step 4.2.2 — Fold in deferred P2 #5 (stale `verified: true`) while in this file.** In `src/commands/verify.ts`, replace

```ts
if (result.ok) { updateTask(absProjectDir, taskId, { verified: true }); }
```

with

```ts
// Persist the actual verdict: a failed re-verify must clear a stale pass,
// otherwise the review gate accepts a task whose latest verification failed.
updateTask(absProjectDir, taskId, { verified: result.ok });
```

Both failure modes then close: verify-then-fail no longer leaves `verified: true` from the earlier pass, and the CLI's `in-progress` reset (plus the MCP reset from Fix 2.4) covers the re-claim path.

**Step 4.2.3 — Tests.** Add a `verify_task` describe block to `tests/unit/mcp/tools.test.ts` (and the same for `push_tasks` as a cheap win — mock `../commands/push.js`).

Because `core/operations.ts` reaches verify via **dynamic import**, mock at the playwright boundary and let everything else run for real, mirroring `tests/unit/commands/verify.test.ts`:

```ts
vi.mock("playwright", () => {
  const page = { goto: vi.fn().mockResolvedValue(undefined), waitForSelector: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({ first: el, count: vi.fn().mockResolvedValue(1), evaluate: el.evaluate, boundingBox: el.boundingBox }),
    evaluate: vi.fn().mockResolvedValue({}), on: vi.fn(), content: vi.fn().mockResolvedValue("<html/>"), screenshot: vi.fn().mockResolvedValue(Buffer.from("png")) };
  const context = { newPage: vi.fn().mockResolvedValue(page), addCookies: vi.fn(), close: vi.fn() };
  const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn() };
  return { chromium: { launch: vi.fn().mockResolvedValue(browser) } };
});
```

Reuses `createTestTask()` from that file, which writes real JSON into a tmpdir — so the assertions cover the *real* fs path.

Minimum cases (all deterministic, no browser, no network):

| Case | Expectation |
| --- | --- |
| `verifyTaskOp` on UI task with valid baseline, mocked page resolves selector | `ok: true`, `data.ok === true`, `data.taskId === id`, `data.evidenceFiles` non-empty |
| same, but `waitForSelector` rejects | `ok: true` (the call succeeded) **and** `data.ok === false`, `data.diff.selectorResolves === false` |
| **`verified` regression (P2 #5)** | re-verify a task with `verified: true` using a failing selector → persisted task file has `verified: false` |
| no baseline (`createTestTask({ baseline: undefined })`) | `ok: false`, `error.code === "E_NO_BASELINE"` |
| no url | `error.code === "E_NO_URL"`; with `{ url: "http://localhost:3001/x" }` input → succeeds and mock `goto` called with the override |
| selector `"/"` | `error.code === "E_NO_SELECTOR"` |
| unknown id | `error.code === "E_NOT_FOUND"` |
| `chromium.launch` rejects `"Executable doesn't exist"` | `error.code === "E_PLAYWRIGHT_MISSING"` |
| `goto` rejects `ERR_CONNECTION_REFUSED` | `error.code === "E_APP_NOT_RUNNING"` |
| **stdout leak guard** | `const spy = vi.spyOn(console, "log"); …; expect(spy).not.toHaveBeenCalled()` — proves the op no longer routes through `runVerify` |
| **`TextContent` contract** | register via `createMcpServer(tmpDir)`, call `verify_task`, assert `result.content[0].text` is a `string` and `JSON.parse(...).taskId` matches |
| **timeout** | mock `goto` to never resolve, `timeoutMs: 1000`, `vi.useFakeTimers()` → `error.code === "VERIFY_TIMEOUT"`; also assert the browser/context `close()` still ran (`finally` intact) |
| **semaphore** | launch two `verifyTaskOp` calls concurrently with a deferred mock, assert the second's `launch` is not called until the first resolves |

- [ ] `pnpm test` runs these with **no** `playwright install` step — CI stays green on hosts without Chromium. Confirm by running the file in an env without browsers.
- [ ] `verify_task` no longer appears in any skip list / not-implemented note; `grep -n "runVerify" src/core/operations.ts` → no matches.
- [ ] Existing `tests/unit/commands/verify.test.ts` still green (comment-extraction refactor must not change behaviour — its `addComment` assertions still pass).
- [ ] Optional (do not block the PR): a real-browser smoke test `tests/playwright/mcp-verify.test.ts` guarded by browser availability, e.g. `test.skip(!browserAvailable, "chromium not installed")`, hitting a fixture served by `tests/` helpers. The unit suite remains the gate.

---

## Implementation order

```
1. Fix 1.2.1  unref/move setInterval                 [30 min, no deps]      ← unblocks everything
2. Fix 1      telemetry finally + async action + spawn regression test  [deps: 1]
3. Fix 4.2.1  verifyTaskOp → verifyTask (+ VerifyError/addVerifySystemComment export, semaphore, timeout)
   Fix 4.2.2  verified: result.ok                                            [independent of 1–2; file-local]
4. Fix 3      tags/type/priority on --add                                    [independent]
5. Fix 2.2    git mv operations.ts → core/ + 3 import updates + structural tests
6. Fix 2.4    lift review policy into core/operations.updateTask; --edit delegates
   Fix 2.3    --add delegates to core createTask                             [deps: 4, 5]
7. Fix 4.2.3  MCP tool tests for verify_task / push_tasks / parity           [deps: 3, 5, 6]
```

**Why this order**

- **Item 1 first.** It is a two-line, zero-risk change that converts "hangs forever" into "works", and *every* acceptance criterion below is expressed as a spawned-CLI test — which cannot be written at all while RC-A is live. It also unblocks Vitest workers that import `mcp/http.ts`.
- **Fix 1 before Fix 2.** The `try/finally { await flushTelemetry() }` wrapper touches the `tasks` action; doing the ops extraction afterwards keeps the two diffs from colliding in the same 1400-line region.
- **Fix 4.2.1/4.2.2 before the file move.** Editing `verifyTaskOp` in place, then moving the file, keeps the verify diff reviewable; and `verified: result.ok` must exist before the shared gate (item 6) can be trusted to reject stale passes.
- **Fix 3 before 2.3.** Define the correct `--add` semantics first, then let `--add` delegate — otherwise the extraction bakes in the field-dropping bug.
- **Fix 2.4 (gate extraction) last-but-one** because it is the largest behavioural change and needs the spawn harness (item 2) and the corrected `verified` semantics (item 3) to be verifiable.
- **Tests (item 7) last** so they exercise the final wiring; the parity test is only meaningful once both surfaces share one implementation.

**Dependency notes / conflict risks**

- Items 5+6 are the only steps that touch four files simultaneously (`core/operations.ts`, `mcp/manifest.ts`, `mcp/server.ts`, `index.ts`, `tests/unit/mcp/tools.test.ts`). Keep them as one commit per step so `git revert` is clean.
- `tests/unit/mcp/drift.test.ts` has a `toMatchSnapshot()` case — moving files does not change it, but adding/removing tools will require `vitest -u`.
- Vitest `pool: "forks"` with 4–8 forks: any *new* module-scope timer will hang the suite, not the CLI — so the reaper test must call the exported teardown.
- `tsup.cli.config.ts` bundles `src/index.ts` with `minify: true` and only `playwright`/`playwright-core` external. Do not make `playwright` a static import in `core/operations.ts`; keep `await import("../commands/verify.js")` (it already is) or the bundled CLI breaks.

---

## Deferred P2s — disposition

| # | Issue | Where it lands |
| --- | --- | --- |
| 5 | Stale `verified: true` on failed re-verify | **Scheduled** — Fix 4.2.2 (`verified: result.ok`) + Fix 2.4 (`verified:false` reset on `in-progress` in the shared `updateTask`) |
| 6 | No e2e tests for gate behaviour | **Scheduled** — Fix 1.3 spawn harness + Fix 2.5 parity tests; add `tests/e2e/review-gate.test.ts` covering: unverified UI task → blocked; `--skip-verify` → allowed; non-UI task (no url/selector) → auto-allowed; MCP `update_task(review)` on unverified UI task → `E_VERIFY_REQUIRED`; setting `in-progress` clears `verified` |
| 7 | CLI-only gate; Kanban/tRPC moves bypass verify | **Deferred, separate spec.** `src/server/server.ts` `PATCH /api/tasks/:id` (and the tRPC `appRouter` mutation) call `core/tasks.updateTask` directly. Proper fix is to route all server-side status writes through `core/operations.updateTask` too — that is exactly the payoff of Fix 2. Needs UI-side decisions (does the board show a verify prompt? does it auto-run `verify`?) → separate spec, not this PR. Record a `// TODO(mcp-gate)` at the `updateTask` call sites in `server.ts` so the gap is greppable |

**Other newly-found defects — recommend follow-up tickets, explicitly NOT in this PR** (out of scope, listed so they are not lost):

- `pushTasks` ignores `dryRun` (`ctx.dryRun` and `input.dryRun` both unread) on a tool annotated `destructiveHint: true`.
- `claimNextTask` ignores `input.user`, has no atomic CAS/mutex (spec §5.5) → two agents can claim the same task, and does not apply the CLI's created-at tiebreak.
- `updateTask`/`attachFile`/`pushTasks` param names diverge from spec §3 (`commitMessage` vs `commit_message`, `skipVerify` vs `skip_verify`, `contentB64` vs `content_b64`) — LLM-visible schema drift.
- Spec §4/§2 files `mcp/schema.ts` and `mcp/adapters.ts` were never created; `manifest.ts` and `server.ts` duplicate all 10 tool definitions (name/description/input schema) with no drift test enforcing they match → they will diverge. Recommend making `server.ts` register tools **from** `manifest` as a small follow-up.
- Spec §7.4 rate limiting (100 req/min, 10 verify/hour) not implemented; `verify_task` has no timeout until Fix 4.
- `mcpAuth` compares tokens with `!==` (non-constant-time), and falls back to "allow all loopback" using `req.ip` string checks including `ip.includes("localhost")`.
- `http.ts` sets `Access-Control-Allow-Origin: http://localhost:3700` unconditionally rather than omitting CORS headers.
- `manifest.ts` declares `cliRef.command: "verify"` / `"push"` for `verify_task`/`push_tasks`, but those are top-level commands with different flag shapes (`--url` exists, `--json` exists; `push --keep-local-files` exists) — will be validated once the missing drift assertion lands (Fix 3.2.8).

---

## Global acceptance / definition of done

1. `pnpm --filter @vibeflow-tools/cli run build` succeeds (both tsup configs; `dist/cli/index.js` + `dist/index.js` synced).
2. `pnpm --filter @vibeflow-tools/cli run lint` (`tsc --noEmit`) clean.
3. `pnpm test` (unit), `pnpm test:e2e`, `pnpm test:browser` green **with no Chromium installed**, no skips added to work around hangs.
4. `tests/e2e/cli-exit.test.ts` exists and passes for all listed cases, with and without telemetry.
5. `pnpm --filter @vibeflow-tools/cli run mutation` green for `src/core/operations.ts`, `src/commands/verify.ts`, `src/mcp/http.ts`, `src/index.ts` (per `AGENTS.md`, the full checklist applies to every change; single-line edits included).
6. Manual MCP smoke: start `vibeflow serve`, `POST /api/mcp` `initialize` → `tools/list` (10 tools) → `tools/call create_task{title,tags:[...]}` → `tools/call verify_task{id}` returns parseable JSON text content → `tools/call update_task{id,status:"review"}` rejected with `E_VERIFY_REQUIRED` → `tools/call update_task{id,status:"review",skipVerify:true,comment:"..."}` accepted. Session `DELETE` returns 200 and `getSessionCount()` drops.
7. Changeset (minor) per `vibeflow-versioning`; commit per `vibeflow-coding`; task submitted as `review` per `vibeflow-tasks-management` (never `done`).
8. One commit per numbered step, messages `fix(mcp): …` / `refactor(core): move operations layer …`; no `.vibeflow/` files edited directly.
