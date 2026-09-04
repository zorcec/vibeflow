# Implementation Plan — vibeflow codebase audit (task b5ed85db)

Repo: `/home/zorcec/workspace/vibeflow-workspace/vibeflow` (public) · private driver: `/home/zorcec/workspace/vibeflow-workspace/vibeflow-private`
All paths below are relative to `packages/cli/` unless noted.

---

## 0. Scope

### Already fixed this session — DO NOT re-plan (verified in code)

- ✅ `verify_task` MCP op: `verifyTaskOp` in `core/operations.ts` calls `verifyTask` from `../commands/verify.js` with semaphore (`withVerifySemaphore`) + `Promise.race` timeout — commit 58c0db5.
- ✅ `verified: result.ok` persisted in `verifyTask` (`updateTask(absProjectDir, taskId, { verified: result.ok })`) so a stale pass is cleared on failed re-verify — 58c0db5.
- ✅ CLI hang: reaper interval `.unref()` (`mcp/http.ts startSessionReaper`) + telemetry `try/finally` (`runTasksAndFlush` in `src/index.ts`) — 58c0db5.
- ✅ Operations layer at `src/core/operations.ts` (moved from `src/mcp/`) — 58c0db5.
- ✅ Copilot token security issue — removed via task b7f139c1 (in flight at planning time).

### Findings planned (from audit b5ed85db)

| # | Pri | Finding | Phase |
| --- | ----- | --------- | ------- |
| 1 | P0 | Claim atomicity (CLI `--next`, MCP `claim_next_task`, SaaS path) + `ctx.userId` always undefined → `author: undefined` overwrite | 2 |
| 2 | P1 | `PATCH /api/tasks/:id` mass-assignment + bypasses review gates | 3 |
| 3 | P1 | MCP `update_task` parity incomplete (commitMessage/skipVerify/dryRun parsed, never enforced; no comment-on-review gate, no `verified` reset, no research `.md` gate) | 3 |
| 4 | P1 | `pushTasks` ignores `input.dryRun`; `push()` deletes local files with no dry-run | 5 |
| 6 | P1 | Comment edit never broadcast (REST PATCH + tRPC `updateComment`) | 4 |
| 7 | P2 | Double `decodeURIComponent` on file upload | 0 |
| 8 | P2 | `requireSameOrigin` prefix hole | 0 |
| 9 | P2 | MCP session reaper kills active sessions; not tied to server close; listener accumulation | 0 |
| 10 | P2 | `/api/project` missing `gitUserName` | 0 |
| 11 | P2 | `verify.ts` hardcodes port 3700 | 0 |
| 12 | P2 | Read endpoints mutate task data (`migrateLegacyLinkedRefs` on GET) | 1 |
| 13 | P2 | Read-modify-write races on comments/commits (no write lock) | 1 |
| 14 | P2 | MCP `attach_file` bypasses filename/extension validation | 4 |
| 15 | P2 | `mcp/auth.ts` nits (dead localhost check, non-constant-time compare, 30s cache) | 0 |
| S1 | — | `mcp/server.ts` re-declares all 10 tools though `manifest.ts` claims single source of truth | 5 |
| S2 | — | `VALID_STATUSES` duplicated ×6+ locations | 1 |
| S3 | — | `serve()` vs `serveApiOnly()` duplicate ~80 lines | 5 |
| S4 | — | Dead code: `gating.ts canMoveToReview`, overlay `onTaskRefClick`, `getCommentCount`, mcp/auth dead check | 0 |
| S5 | — | Sort duplication: `getPriorityRank` (index.ts) vs `priorityOrder` (operations.ts), different tie-breaks | 1 |
| I1 | — | Conditional claim + author capture | 2 |
| I2 | — | Broadcast normalization | 4 |
| I3 | — | Typed SaaS errors | 4 |
| I4 | — | Verify port from config + cancellation (port in P0, cancellation in P5) | 0/5 |
| I5 | — | Push orphan cleanup | 5 |
| I6 | — | Timing-safe MCP auth compare | 0 |

### Global constraints (shared-tree)

- Workers run **SEQUENTIALLY in the same tree** — one writer at a time. Each phase must leave the repo green: `tsc --noEmit` clean, `pnpm build` passes, `pnpm test` (unit) passes, existing e2e unaffected (`pnpm test:e2e` for phases touching server/CLI behavior).
- Every phase = ONE worker session, one commit, changeset per repo versioning rules.
- No phase starts until the previous phase is committed and green.
- Workers must NOT edit `.vibeflow/` task files directly; use the CLI (`vibeflow tasks --edit ...`).

---

## Phase 0 — Quick wins & dead code (findings #7, #8, #9, #10, #11, #15, S4, I6)

**Goal:** shrink the risk surface with pure deletions and one-liners before structural work.

**Files:** `src/server/server.ts`, `src/commands/verify.ts`, `src/mcp/auth.ts`, `src/mcp/http.ts`, `src/core/comments.ts`, `src/core/gating.ts`, overlay React source (`src/client/overlay/**` — locate `onTaskRefClick` by grep), plus new unit tests.

### 0.1 — #7 Double decodeURIComponent (server.ts, upload handler)

Current:

```ts
const { id, filename: rawFilename } = req.params;
if (!isValidFilename(rawFilename)) { ... }
const ext = extname(decodeURIComponent(rawFilename)).toLowerCase();
...
const info = saveFile(projectDir, id, decodeURIComponent(rawFilename), data);
```

Express already percent-decodes `req.params`. The second decode throws `URIError` on a literal `%` (→ 500) and mis-decodes `a%2520b.txt` → name mismatch between the stored file and the task ref. **Change:** delete both `decodeURIComponent(...)` calls; use `rawFilename` directly for `extname` and `saveFile`. Keep `isValidFilename(rawFilename)` (already operates on the decoded value).

### 0.2 — #8 requireSameOrigin (server.ts)

Current:

```ts
const origin = req.headers.origin;
if (origin && !origin.startsWith("http://localhost")) {
  res.status(403).json({ error: "Forbidden" });
  return false;
}
```

`http://localhost.attacker.com` passes; `http://127.0.0.1:8000` is rejected. **Change:** replace with URL parse:

```ts
function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "[::1]");
  } catch { return false; }
}
// requireSameOrigin:
if (origin && !isLoopbackOrigin(origin)) { 403; return false; }
```

Note `new URL("http://[::1]:3700").hostname === "[::1]"`.

### 0.3 — #10 /api/project gitUserName (server.ts, registerTaskApi)

Current:

```ts
app.get("/api/project", (_req, res) => {
  res.json({ name: getProjectName(projectDir), projectDir, branch: getCurrentBranch(projectDir) });
});
```

**Change:** add `gitUserName: getGitUser(projectDir).name` (getGitUser is already imported in server.ts). Also add the same field to the tRPC `project` query (`server/trpc.ts`) for parity.

### 0.4 — #11 verify port from config (commands/verify.ts, step 4)

Current:

```ts
const targetUrl = rawUrl.startsWith("http")
  ? rawUrl
  : `http://localhost:3700${rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl}`;
```

**Change:** `const port = readConfig(absProjectDir).port;` (import `readConfig` from `../core/config.js`) → `http://localhost:${port}...`. (Cancellation support is deferred to Phase 5; this phase is config-only.)

### 0.5 — #15 + I6 mcp/auth.ts

- Remove dead `ip.includes("localhost")` from `isLoopback` (IP strings never contain "localhost").
- Timing-safe compare: replace `providedToken !== token` with a constant-time compare over fixed-length digests:

  ```ts
  import { createHash, timingSafeEqual } from "node:crypto";
  function tokensEqual(a: string, b: string): boolean {
    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    return timingSafeEqual(ha, hb);
  }
  ```

- Remove the 30s module-level token cache (`cachedToken`, `tokenCacheTime`, `TOKEN_CACHE_TTL`) — a per-request `readFileSync` of a small JSON file is negligible, and the cache goes stale right after `vibeflow login`.

### 0.6 — #9 MCP session reaper (mcp/http.ts)

Current problems (all in `src/mcp/http.ts`):

- `createdAt` is set once at session creation and never refreshed → `reapStaleSessions` kills sessions that are actively used (30-min TTL from creation, not last activity).
- The reaper interval is module-global and only cleared on `process` SIGTERM/SIGINT handlers — it is never tied to `ServeInstance.close()`, and the signal handlers (`handlersRegistered` latch) accumulate across multiple mounts in long-lived processes and are never removed.

**Change:**

- Add `lastSeen: number` to `McpSession`; set on creation and update on every handled request (POST/GET/DELETE for that session id).
- Reap on `Date.now() - session.lastSeen > SESSION_TTL`.
- Export `disposeMcp(): void` that clears the interval, closes all sessions, clears the map, and resets the module latches. Call it from `close()` in `serveApiOnly`/`serve` (server.ts) after `wss.close()` — the single shutdown path — and keep the existing `stopMcpForTests` delegating to it.
- Replace the module-global `process.on("SIGTERM"/"SIGINT")` handlers with nothing (process exit closes transports anyway once close() handles it); if a safety net is desired, register one lazily with `process.once` inside `mountMcp` and remove it in `disposeMcp`.

### 0.7 — S4 dead code deletions (grep first, delete after verifying zero references)

- `src/core/gating.ts`: `canMoveToReview` (and the whole file if it exports nothing else live). Verify with `grep -rn "canMoveToReview\|from \"./gating" src tests`.
- `src/core/comments.ts`: `getCommentCount` — verify zero references (`grep -rn getCommentCount src tests packages`), delete.
- Overlay source: `onTaskRefClick` handler in `src/client/overlay/**` — locate by grep, remove the handler and its wiring (button/prop). Rebuild overlay bundle via the build script (`prebuild` regenerates `overlay-bundle.gen.ts`).
- mcp/auth dead check: covered in 0.5.

### Tests (Phase 0)

Unit (`tests/unit/`, flat pattern like `tests/unit/tasks.test.ts`):

- `uploadFilename.test.ts`-style: drive the express app? Simpler — unit-test the pure pieces: `isLoopbackOrigin` (export it from server.ts) with table: `http://localhost:3700` ok, `http://127.0.0.1:8000` ok, `http://localhost.attacker.com` **403**, `https://evil.com` 403, `javascript:` 403.
- For the upload route, add an e2e-style test in `tests/e2e/` that boots the API-only server (`serve(undefined, { port: 0/3701, projectDir: tmp, _testToken: null, _testWorkspace: null })`), POSTs a file named `report%20v2.md` and `bad%.md`, and asserts: 200 + stored name `report v2.md`; no 500 on `%`.
- verify port: unit test that builds targetUrl via a tiny exported helper or by running `verifyTask` against a task with relative url in a tmp project with `config.json {"port": 4123}` — assert navigation attempt went to `:4123` (assert via a listening http server on 4123 receiving the request).
- mcp/http: unit test — create session via `mountMcp` on a test express app, POST initialize, then simulate: freeze `lastSeen` older than TTL but issue a fresh request → session must survive; idle past TTL → reaped. Also `disposeMcp()` clears everything (reuse `getSessionCount`).
- auth: unit test `tokensEqual`-guarded behavior (valid token passes; wrong length/token fails; no crash on empty).

### Acceptance criteria

- `POST /api/tasks/:id/files/:filename` with `%` in name returns 200 (or a clean 400), never 500 URIError; `report%20v2.md` stored as `report v2.md`.
- `requireSameOrigin` accepts 127.0.0.1/localhost, rejects `localhost.attacker.com`.
- `/api/project` includes `gitUserName`.
- `vibeflow verify <id>` uses the port from `.vibeflow/config.json`.
- MCP auth uses timing-safe compare; no dead loopback check; no stale cache.
- Active MCP sessions are not reaped; `close()` disposes reaper + sessions; no signal-handler accumulation.
- `canMoveToReview`, `getCommentCount`, `onTaskRefClick` deleted; `tsc --noEmit` + build + tests green.

**Complexity:** S–M (many small edits across 6 files; low risk).

### Worker prompt — Phase 0 (copy-pasteable)

```bash
You are implementing Phase 0 of the vibeflow audit plan (/tmp/b5ed85db-impl-plan.md, repo /home/zorcec/workspace/vibeflow-workspace/vibeflow, package packages/cli).

Workflow: claim a task first (`vibeflow tasks --next` from vibeflow-private/), implement, run the full checklist (build, unit tests, changeset), commit, submit as review. NEVER edit .vibeflow/ files directly; never set status done.

Implement exactly these changes in packages/cli (see plan §Phase 0 for code quotes):
1. server/server.ts upload handler: remove BOTH decodeURIComponent() calls (Express already decoded req.params). Keep isValidFilename(rawFilename).
2. server/server.ts: replace requireSameOrigin's `origin.startsWith("http://localhost")` with isLoopbackOrigin() URL-parse helper (accept localhost/127.0.0.1/::1 hostnames with http/https, reject everything else incl. localhost.attacker.com).
3. server/server.ts GET /api/project: add gitUserName: getGitUser(projectDir).name; also add gitUserName to the tRPC `project` query in server/trpc.ts.
4. commands/verify.ts: use readConfig(absProjectDir).port instead of hardcoded 3700 for relative target URLs.
5. mcp/auth.ts: delete the dead `ip.includes("localhost")` check; delete the 30s token cache; compare tokens with a timing-safe sha256+timingSafeEqual helper.
6. mcp/http.ts: add lastSeen to McpSession, refresh it on every request for that session, reap on lastSeen+TTL; add disposeMcp() and call it from ServeInstance.close() in server.ts (both serve paths); remove the module-global SIGTERM/SIGINT handler accumulation.
7. Dead code (grep first to confirm zero references, then delete): core/gating.ts canMoveToReview (drop the file if nothing else live), core/comments.ts getCommentCount, overlay onTaskRefClick handler (locate under src/client/overlay/).

Tests (mirror tests/unit/*.test.ts patterns; tmp dirs via mkdtemp):
- isLoopbackOrigin table test (export it).
- e2e: boot API-only server on a tmp project (serve(undefined,{...,_testToken:null,_testWorkspace:null})), POST file `report%20v2.md` (200, stored as `report v2.md`) and `bad%.md` (no 500).
- verify port test with config.json {"port":4123} against a local http server.
- mcp/http session-survival and disposeMcp tests (reuse getSessionCount/clearSessions/stopMcpForTests exports).
- tokensEqual behavior test.

Done when: tsc --noEmit clean, `pnpm build` passes, `pnpm test` green (run from repo root or packages/cli), e2e target tests green, dead code removed. Commit with a changeset. Do NOT start Phase 1 — stop after commit.
```

---

## Phase 1 — Storage foundations: write lock (#13), pure reads (#12), status/sort/file-validation consolidation (S2, S5, #14-prereq)

**Goal:** make task-file mutation serialized and reads side-effect-free, and hoist the duplicated constants into `core/types.ts` so later phases have one place to work.

**Files:** `src/core/types.ts`, NEW `src/core/lock.ts`, `src/core/tasks.ts`, `src/core/comments.ts`, `src/core/files.ts`, `src/server/server.ts`, `src/server/trpc.ts`, `src/core/operations.ts`, `src/index.ts`, `src/mcp/manifest.ts` (only if it references the status enum inline — it imports from operations), tests.

### 1.1 — S2: single source for statuses

Add to `core/types.ts`:

```ts
export const TASK_STATUSES = ["backlog","todo","in-progress","review","done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number]; // move existing type here-adjacent
export const TASK_STATUS_ENUM = z.enum(TASK_STATUSES); // if zod is acceptable in types.ts; otherwise export the array and build z.enum(TASK_STATUSES) at call sites
export function isTaskStatus(v: unknown): v is TaskStatus
```

Replace:

- `core/tasks.ts` module-level `VALID_STATUSES` (used by `normalizeTask`) → `TASK_STATUSES`.
- `index.ts` `VALID_STATUSES` const + inline `validSaasStatuses`/`validStatuses` arrays in add-mode → `TASK_STATUSES` / `isTaskStatus`.
- `server.ts` `VALID_CREATE_STATUSES` + `VALID_PATCH_STATUSES` → `TASK_STATUSES`.
- `trpc.ts` `taskStatusSchema = z.enum([...])` → `z.enum(TASK_STATUSES)`.
- `core/operations.ts` four zod status enums → `z.enum(TASK_STATUSES)`.

### 1.2 — S5: unified priority rank + comparator

Add to `core/types.ts` (or `core/sorting.ts` — pick one and keep it):

```ts
export function getPriorityRank(priority?: string): number // critical=0, high=1, medium/default=2, low=3, case-insensitive
export function compareTasksByPriorityThenCreated<T extends {priority?: string; created: string}>(a: T, b: T): number
```

- `index.ts`: delete local `getPriorityRank`; `--next` local + SaaS sort and list-mode sort use the shared function (keep list-mode's extra status/date/id tie-breaks layered on top; only the priority tier becomes shared).
- `core/operations.ts claimNextTask`: delete inline `priorityOrder` map; use `compareTasksByPriorityThenCreated` (this also fixes the missing tie-break: operations.ts previously had **no** tie-break while CLI `--next` sorts by `created` — they could pick different tasks for the same board).

### 1.3 — #13: cross-process task write lock (NEW core/lock.ts)

```ts
export function taskLockPath(projectDir: string, taskId: string): string // join(projectDir, PROTO_DIR, "tasks", ".locks", `${taskId}.lock`)
export async function withTaskLock<T>(lockPath: string, fn: () => Promise<T> | T, opts?: { timeoutMs?: number; staleMs?: number }): Promise<T>
```

Implementation:

- **In-process serialization:** a module-level `Map<lockPath, Promise<unknown>>` chain — each caller appends to the chain and runs `fn` after the previous settles (prevents same-process async interleave, e.g. two concurrent HTTP requests).
- **Cross-process:** create the lockfile with `openSync(p, "wx")` (exclusive); on `EEXIST`, retry loop (10ms sleep) up to `timeoutMs` (default 5000); if the existing lockfile mtime is older than `staleMs` (default 10000), unlink and take over. Always `unlinkSync` in `finally`. Keep the lock file empty; never log per-acquisition.
- Re-entrancy contract: **`fn` must not itself call `withTaskLock` on the same path** (no re-entrancy) — document at the function.

Apply:

- `core/comments.ts`: `addComment`, `updateComment`, `deleteComment` each wrap their entire read-modify-write in `withTaskLock(taskLockPath(projectDir, taskId), ...)`. Because of the no-reentrancy rule, refactor these three to read via `findTaskFilePath`/`readTaskFile` and write via a newly-exported `writeTaskJson(projectDir, task)` from `tasks.ts` instead of calling `updateTask` (which must stay lock-free internally or take the lock itself — see below).
- `core/tasks.ts updateTask`: wrap the find→read→merge→write in `withTaskLock(taskLockPath(projectDir, taskId))`. `updateTask` then becomes safe for all direct callers (PATCH route, verify, claim in Phase 2). Comment paths must NOT go through `updateTask` while holding the lock (they use `writeTaskJson` directly per above).
- `src/index.ts` commit path (both `--commit` mode and edit-mode auto-commit): the read `task.commits` → append → `updateTask` sequence is wrapped in `withTaskLock` (or refactor to a single `updateTask` call that receives the appended array — the lock around `updateTask` alone still leaves read-outside-lock; so wrap the whole sequence).

### 1.4 — #12: read endpoints stop mutating (`core/files.ts`)

Current: `migrateLegacyLinkedRefs` (unlinks `.linked.json`, calls `setTaskFileRefs` → `updateTask`) is invoked from `listFiles` (GET /api/tasks/:id/files, GET /api/tasks fileCount, tRPC `tasks`/`files` queries, CLI list/get/next) and `getFilePath` (file download GET) — GETs mutate task JSON.
**Change:**

- Add `readTaskFileRefs(projectDir, taskId): TaskFileRef[]` (plain read, no migration, no unlink). `listFiles` and `getFilePath` switch to it.
- `saveFile` and `deleteFile` keep calling the migrating variant (write paths may migrate).
- One-time migration sweep: new export `migrateAllLegacyLinkedRefs(projectDir): number` in `files.ts` (loop `listTasks`, run `migrateLegacyLinkedRefs` per task, return count). Call it once from `ensureTaskDirs`' callers at server startup — in `registerTaskApi` before routes are registered (both serve paths) — so data converges without read-path writes. (Do not put it inside `ensureTaskDirs` itself — it runs per task write too.)

### Tests (Phase 1)

- `tests/unit/lock.test.ts`: concurrent `withTaskLock` on same path — second caller waits; stale lockfile (>staleMs) is taken over; lockfile removed after fn settles; timeout throws/rejects cleanly.
- `tests/unit/comments-race.test.ts`: fire `addComment` ×20 concurrently (Promise.all) on one task → all 20 comments persist (today several are lost).
- `tests/unit/files-pure-read.test.ts`: craft a task with a legacy `.linked.json`; call `listFiles` twice → task JSON mtime/content unchanged and manifest still present; call `saveFile` → migration happens; after server-start sweep (call `migrateAllLegacyLinkedRefs`) manifest gone.
- Statuses/comparator: replace enum literals in existing tests if any assert them; add comparator test (critical beats high; equal priority → older `created` first — this pins the operations.ts tie-break fix).
- Existing suites must stay green (`tasks.test.ts`, comments tests if present).

### Acceptance criteria

- 20 concurrent `addComment` calls persist 20 comments (no lost updates).
- GET endpoints perform zero writes to `.vibeflow/` (verify via fs snapshot in test).
- `TASK_STATUSES` is the only status list; grep shows no other inline enum of the five statuses (except generated/client bundles).
- One `getPriorityRank`/comparator in core; operations.ts claim sort now has the created-tie-break.
- tsc/build/tests green.

**Complexity:** M (lock primitive + careful refactor of comments write path; medium risk — writeTaskJson export touches storage layer).

### Worker prompt — Phase 1 (copy-pasteable)

```bash
You are implementing Phase 1 of the vibeflow audit plan (/tmp/b5ed85db-impl-plan.md, repo /home/zorcec/workspace/vibeflow-workspace/vibeflow, package packages/cli). Phase 0 is already committed — build on it, don't re-do it.

Workflow: claim a task (`vibeflow tasks --next`), implement, run build + full unit suite, changeset, commit, submit review. NEVER edit .vibeflow/ directly. One writer: do not touch files outside the listed set unless tsc forces a trivial import fix.

Implement:
1. core/types.ts: add TASK_STATUSES (readonly tuple), isTaskStatus(), getPriorityRank(), compareTasksByPriorityThenCreated() (priority tier, then created ascending). Replace every inline status enum/array: core/tasks.ts VALID_STATUSES, src/index.ts VALID_STATUSES + inline validStatuses/validSaasStatuses, server/server.ts VALID_CREATE_STATUSES + VALID_PATCH_STATUSES, server/trpc.ts taskStatusSchema, core/operations.ts 4× z.enum([...]).
2. NEW core/lock.ts: withTaskLock(lockPath, fn, {timeoutMs=5000, staleMs=10000}) — in-process promise chain per lockPath + cross-process O_EXCL ("wx") lockfile with retry, stale-takeover by mtime, unlink in finally. Export taskLockPath(). No re-entrancy (document it).
3. core/tasks.ts: export writeTaskJson(); wrap updateTask's read-merge-write in withTaskLock(taskLockPath(projectDir, taskId)).
4. core/comments.ts: addComment/updateComment/deleteComment wrap their whole read-modify-write in withTaskLock and write via writeTaskJson directly (NOT via updateTask — no re-entrancy).
5. src/index.ts: wrap both commit-linking sequences (--commit mode and edit-mode auto-commit) in withTaskLock around the read-task→append-commits→updateTask flow; delete local getPriorityRank and use the shared comparator.
6. core/operations.ts claimNextTask: use compareTasksByPriorityThenCreated (adds the missing tie-break).
7. core/files.ts: add readTaskFileRefs() (pure read). listFiles() and getFilePath() stop migrating (no unlink/updateTask). saveFile/deleteFile keep migrating. Add migrateAllLegacyLinkedRefs(projectDir); call it once at server startup in registerTaskApi before routes register.

Tests (mirror tests/unit flat pattern, mkdtemp tmp dirs): lock concurrency/stale-takeover/timeout; 20× concurrent addComment all persist; listFiles is side-effect-free (legacy manifest untouched, task file unchanged) while saveFile migrates; comparator ordering. All existing tests stay green.

Done when: tsc --noEmit clean, pnpm build passes, pnpm test green. Commit + changeset. Do NOT start Phase 2.
```

---

## Phase 2 — Atomic claim + author capture (#1, I1)

**Goal:** one atomic, locked claim path shared by CLI `--next` and MCP `claim_next_task`; authors never overwritten with `undefined`.

**Files:** `src/core/tasks.ts`, `src/core/operations.ts`, `src/mcp/server.ts`, `src/index.ts`, `src/saas/client.ts`, tests.

### 2.1 — core claim primitive (core/tasks.ts)

New export:

```ts
export function claimNextTaskAtomic(
  projectDir: string,
  opts: { type?: string; user?: string; tag?: string[]; author?: string },
): Task | null
```

Behavior (all inside `withTaskLock(taskLockPath(projectDir, "claim"))` — a **global claim lock**, not per-task, so candidate selection is serialized):

1. List tasks (via `listTasksWithPaths`), filter status==="todo" + type/user/tag filters, sort with `compareTasksByPriorityThenCreated`.
2. For the first candidate, re-read the task file **inside the lock** and confirm `status === "todo"` (guard against a writer that changed it after our list snapshot). If taken, advance to the next candidate.
3. Write via `writeTaskJson`: `{ ...task, status: "in-progress", updated: now, ...(opts.author ? { author: opts.author } : {}) }` — **only set `author` when defined** (never `author: undefined`, which today overwrites the existing author through the `{...task, ...updates}` spread in `updateTask`).
4. Return the claimed task or `null` when nothing claimable.

### 2.2 — MCP ctx.userId (mcp/server.ts, operations.ts)

Current (`mcp/server.ts createMcpServer`):

```ts
const ctx: OperationContext = { projectDir, mode };
```

`userId` is never set anywhere → `claimNextTask` writes `author: ctx.userId` = `undefined`, destroying the task's author.
**Change:**

- `const ctx: OperationContext = { projectDir, mode, userId: getGitUser(projectDir).name };` (import `getGitUser` from `../core/git-user.js`).
- `core/operations.ts claimNextTask`: replace the filter-sort-update body with `claimNextTaskAtomic(ctx.projectDir, { type: input.type, tag: input.tag, user: input.user, author: ctx.userId })` (keep dryRun preview branch; make the preview use the same candidate ordering). Error mapping unchanged (`NO_TASKS_AVAILABLE` on null).

### 2.3 — CLI --next local path (index.ts)

Current:

```ts
const nextUpdated = updateTask(nextProjectDir, nextLocalTask.id, { status: "in-progress" });
```

Race: two agents running `--next` simultaneously can claim the same task (no re-check) and never capture the author.
**Change:** call `claimNextTaskAtomic(nextProjectDir, { type: opts.type, user: opts.user, tag: opts.tag, author: getGitUser(nextProjectDir).name })` (import `getGitUser` from `./core/git-user.js`). Keep the existing rendering/instructions flow; `null` → keep current "No todo tasks found" handling. Delete the local filter/sort block (shared function now owns it). Keep the SaaS-branch sort as-is except the shared comparator from Phase 1.

### 2.4 — SaaS path (index.ts + saas/client.ts)

Current SaaS `--next`: `updateSaasTask(nextTask.id, { status: "in-progress" })` — no author, no precondition.
**Change (client-side, no server changes assumed):**

- `saas/client.ts updateSaasTask` patch type gains `author?: string`.
- CLI SaaS `--next` sends `author: workspace?.email ?? undefined` and stays best-effort atomic: after a successful update, re-fetch the task; if it came back claimed by someone else (`author` mismatch that isn't ours), log the existing "another agent may be working on this task" warning. Full server-side compare-and-swap is out of this repo's scope — record as a **gap** (see §Gaps).

### Tests (Phase 2)

- `tests/unit/claim.test.ts`: seed 3 todo tasks (Critical/High/Medium + equal-priority different `created`); assert atomic claim picks correct task, sets in-progress, sets author when provided, does NOT touch `author` when `author` is undefined (pre-condition: task already has author).
- Concurrency: seed 2 todo tasks, run `claimNextTaskAtomic` twice via Promise.all from two "processes" is not possible in-unit — instead call the function twice sequentially with a task mutated between (status already in-progress) → second call skips it. For true cross-process, add `tests/e2e/claim-race.test.ts`: spawn two `node dist/cli/index.js tasks --next --json` processes simultaneously on one tmp project; assert exactly one claims each task and both `author` fields are set.
- MCP: unit test `createMcpServer` ctx wiring indirectly — call `claim_next_task` through a mounted test app and assert `author === getGitUser(tmpDir).name`.

### Acceptance criteria

- Two simultaneous `tasks --next` on the same board claim two different tasks (e2e).
- Claimed tasks always get a real `author` (CLI + MCP); MCP claim never writes `author: undefined`.
- Candidate ordering identical between CLI `--next` and MCP `claim_next_task`.
- tsc/build/tests green.

**Complexity:** M.

### Worker prompt — Phase 2 (copy-pasteable)

```bash
You are implementing Phase 2 of the vibeflow audit plan (/tmp/b5ed85db-impl-plan.md, repo /home/zorcec/workspace/vibeflow-workspace/vibeflow, package packages/cli). Phases 0-1 are committed — the write lock (core/lock.ts), TASK_STATUSES, and the shared priority comparator exist.

Workflow: claim a task (`vibeflow tasks --next`), implement, build + unit tests (+ e2e), changeset, commit, submit review.

Implement:
1. core/tasks.ts: export claimNextTaskAtomic(projectDir, {type?, user?, tag?, author?}) — inside withTaskLock on a claim lock (use taskLockPath(projectDir, "claim")): filter todo + type/user/tag, sort compareTasksByPriorityThenCreated, re-read candidate file inside the lock to confirm still todo (advance on taken), write via writeTaskJson with status in-progress + updated timestamp, and set author ONLY when opts.author is defined (never author: undefined). Return claimed Task | null.
2. core/operations.ts claimNextTask: delegate to claimNextTaskAtomic(ctx.projectDir, {type: input.type, user: input.user, tag: input.tag, author: ctx.userId}); keep dryRun preview (same ordering) and NO_TASKS_AVAILABLE mapping.
3. mcp/server.ts createMcpServer: ctx = { projectDir, mode, userId: getGitUser(projectDir).name } (import from ../core/git-user.js).
4. src/index.ts local --next: replace filter/sort/updateTask block with claimNextTaskAtomic(nextProjectDir, {type: opts.type, user: opts.user, tag: opts.tag, author: getGitUser(nextProjectDir).name}); keep existing output/instructions flow; null → "No todo tasks found" path.
5. saas/client.ts updateSaasTask: add author?: string to the patch; src/index.ts SaaS --next sends author: workspace?.email, then re-fetches the task and warns if it came back claimed by another author (keep existing warning text).

Tests: tests/unit/claim.test.ts (selection order, author capture, author-undefined never overwrites, already-claimed skip); tests/e2e/claim-race.test.ts (two spawned `tasks --next --json` processes on one tmp project claim different tasks with authors set); MCP claim author test via mounted app.

Done when: tsc clean, build passes, unit + the new e2e green. Commit + changeset. Do NOT start Phase 3.
```

---

## Phase 3 — Gate extraction, PATCH hardening, MCP update parity (#2, #3)

**Goal:** one shared review-gate implementation used by CLI, REST PATCH, and MCP `update_task`; mass-assignment closed.

**Files:** NEW `src/core/review-gate.ts`, NEW `src/core/git.ts`, `src/index.ts`, `src/server/server.ts`, `src/core/operations.ts`, `src/mcp/manifest.ts` (descriptions only if wording changes), tests.

### 3.1 — Shared commit helper (NEW core/git.ts)

Extract the git-commit-and-link logic duplicated twice in `index.ts` (commit mode and auto-commit):

```ts
export function commitTaskChanges(projectDir: string, taskId: string, message: string): { ok: true; sha: string } | { ok: false; error: string }
```

- Runs `git commit -m "<message> [proto:<taskId>]"` (execFileSync), `git rev-parse HEAD`, appends `{ sha, message, timestamp }` to the task's `commits` inside `withTaskLock`, returns the sha. Both `index.ts` call sites and (in 3.3) MCP use it. Note: commit must happen AFTER the task update + comment persist (existing CLI ordering comment says exactly this — preserve it).

### 3.2 — Shared review gate (NEW core/review-gate.ts)

```ts
export interface ReviewGateContext { projectDir: string; settings: ReturnType<typeof loadSettings>; }
export type ReviewGateResult = { ok: true } | { ok: false; code: string; message: string; suggestion?: string };
export function checkReviewTransition(projectDir: string, taskId: string, opts: {
  comment?: string; commitMessage?: string; branch?: string; reportFile?: string; skipVerify?: boolean;
}, ctx: ReviewGateContext): ReviewGateResult
```

Port the CLI edit-path checks verbatim (they are the spec):

1. `comment` required when setting review (unconditional CLI rule) → `REVIEW_COMMENT_REQUIRED`.
2. autoComment ON + no comment → same code (CLI's second check becomes redundant → keep single check).
3. autoCommit ON + no commitMessage → `COMMIT_MESSAGE_REQUIRED`.
4. createBranch ON + no branch → `BRANCH_REQUIRED`.
5. verify gate: `requireVerifyBeforeReview && !skipVerify` → load task; UI task = `hasSelector && hasUrl`; if UI task && !task.verified → `VERIFY_REQUIRED` with suggestion `vibeflow verify <id>`.
6. research gate: type research → unless `reportFile` provided (validated: exists + `.md`) or an attached `.md` file exists (`listFiles`) → `RESEARCH_REPORT_REQUIRED`.
Return first failure. Non-review transitions return `{ok:true}` immediately.

CLI `index.ts` edit path: replace the inline blocks (done-warning stays; VALID status check stays) — the four gate blocks + research `.md` handling + verify gate — with a single `checkReviewTransition` call. The actual `--report-file` upload + local unlink stays in CLI (it's a CLI-side side effect; the gate only validates).

### 3.3 — MCP update_task parity (core/operations.ts)

Current `updateTask` op only maps status/title/description/branch and appends a comment unconditionally. **Change:**

- If `input.status === "review"`: run `checkReviewTransition(projectDir, id, { comment: input.comment, commitMessage: input.commitMessage, skipVerify: input.skipVerify }, { settings: loadSettings(projectDir) })` — on failure return `{ ok: false, error: { code, message, suggestion } }` **without writing anything**.
- `input.status === "in-progress"` → include `verified: false` in updates (parity with CLI's verified-reset).
- After a successful review transition: if `settings.autoCommit && input.commitMessage` → `commitTaskChanges(...)`; include the sha in `steps` or result data.
- `input.dryRun` / `ctx.dryRun` already return preview without writing — keep, but make the preview run the gate too and report would-be gate failures (so dry-run is truthful).
- Comment added only after all gates pass (same ordering guarantee as CLI).

### 3.4 — PATCH /api/tasks/:id hardening (server.ts)

Current: `const updates = req.body as Partial<Pick<Task, ...>>` — a **type-level** lie; at runtime every body key (incl. `verified`, `author`, `commits`, `comments`, `files`, `authStateEnc`, `id`, `created`) flows into `updateTask`. **Change:**

```ts
const ALLOWED_PATCH_KEYS = new Set(["status","title","description","type","priority","reportBack","agent","model","tags","sortKey","branchName"]);
const updates = Object.fromEntries(Object.entries(req.body as Record<string, unknown>).filter(([k]) => ALLOWED_PATCH_KEYS.has(k)));
```

(mirrors the existing settings-route whitelist pattern). Keep the status validity check and the existing broadcast.

- Review gates on PATCH: PATCH is the **human/UI** path (kanban drag). Apply the invariant gates only: if `updates.status === "review"` and the task type is research and no `.md` attached → 422 `{ error: "RESEARCH_REPORT_REQUIRED" }` (reuse the gate's check). Deliberately do NOT require comment/commit/verify on PATCH — the UI supplies comments separately and humans may skip verify. Document this decision in the route comment.

### Tests (Phase 3)

- `tests/unit/review-gate.test.ts`: each rule fires/doesn't (comment, autoCommit, createBranch, verify gate incl. skipVerify + non-UI-task auto-skip, research .md with attached file / reportFile / neither).
- `tests/unit/patch-whitelist.test.ts` (e2e style): boot API server; PATCH with body `{ status: "review", verified: true, author: "attacker", commits: [...] }` → response task has `verified` unchanged, `author` unchanged, no new commits; `status` applied. Research-task review without .md → 422.
- `tests/unit/git-commit-helper.test.ts`: git init a tmp repo, stage a file, call `commitTaskChanges` → sha returned, task.commits appended with `[proto:<id>]` message.
- MCP parity: `update_task` status review without comment → error envelope `REVIEW_COMMENT_REQUIRED`; with comment + autoCommit + commitMessage → commits linked; `in-progress` transition resets `verified` to false.

### Acceptance criteria

- Single gate implementation used by CLI edit path and MCP; both enforce identical rules.
- PATCH runtime whitelist blocks `verified/author/commits/comments/files/authStateEnc/id/created`.
- MCP `update_task` enforces commitMessage, comment-on-review, verified reset, research gate, skipVerify.
- Git-commit linking shared by CLI commit mode, CLI auto-commit, and MCP.
- tsc/build/tests green.

**Complexity:** L (largest phase; touches gate logic in 3 surfaces — do not rush).

### Worker prompt — Phase 3 (copy-pasteable)

```bash
You are implementing Phase 3 of the vibeflow audit plan (/tmp/b5ed85db-impl-plan.md, repo /home/zorcec/workspace/vibeflow-workspace/vibeflow, package packages/cli). Phases 0-2 are committed (write lock, TASK_STATUSES, claimNextTaskAtomic).

Workflow: claim a task, implement, build + unit tests, changeset, commit, submit review.

Implement:
1. NEW core/git.ts: commitTaskChanges(projectDir, taskId, message) → runs `git commit -m "<msg> [proto:<id>]"`, rev-parse HEAD, appends commit record inside withTaskLock, returns {ok,sha}|{ok,error}. Refactor src/index.ts commit mode AND edit-mode auto-commit to use it (preserve "commit after status+comment persist" ordering and all console output).
2. NEW core/review-gate.ts: checkReviewTransition(projectDir, taskId, {comment?, commitMessage?, branch?, reportFile?, skipVerify?}, {settings}) — port the CLI edit-path gates verbatim: comment required on review; commitMessage when autoCommit; branch when createBranch; verify gate (requireVerifyBeforeReview && !skipVerify, UI task = selector!="/" && url, blocked unless task.verified) → VERIFY_REQUIRED; research gate (research type needs --report-file .md that exists, or an attached .md) → RESEARCH_REPORT_REQUIRED. Error codes: REVIEW_COMMENT_REQUIRED, COMMIT_MESSAGE_REQUIRED, BRANCH_REQUIRED, VERIFY_REQUIRED, RESEARCH_REPORT_REQUIRED.
3. src/index.ts edit path: replace the four inline gate blocks + research .md handling + verify-gate block with checkReviewTransition (keep --report-file upload/unlink and the done-warning where they are; keep status validity check). Failure → same console output shape + ExitCode.USAGE.
4. core/operations.ts updateTask: on input.status==="review" run the gate first (loadSettings(projectDir)); on failure return {ok:false,error:{code,message,suggestion}} with NOTHING written. On in-progress include verified:false. After review: if settings.autoCommit && input.commitMessage → commitTaskChanges, add sha to steps. Run the gate in dry-run preview too (report would-be failures).
5. server/server.ts PATCH /api/tasks/:id: runtime whitelist ALLOWED_PATCH_KEYS = status,title,description,type,priority,reportBack,agent,model,tags,sortKey,branchName (filter Object.entries like the settings route). Keep status validation + broadcast. If updates.status==="review": research tasks without attached .md → 422 RESEARCH_REPORT_REQUIRED. Add a route comment: PATCH is the human/UI path — comment/commit/verify gates are enforced at CLI/MCP only.

Tests: tests/unit/review-gate.test.ts (all five rules + skips); tests/unit/patch-whitelist.test.ts (e2e-style boot: mass-assignment keys ignored, research-review 422); commit-helper test in a git-init tmp repo; MCP parity tests (review w/o comment errors; autoCommit path links sha; in-progress resets verified). All existing tests green.

Done when: tsc clean, build passes, tests green. Commit + changeset. Do NOT start Phase 4.
```

---

## Phase 4 — Client sync & error surfaces (#6 broadcast, #14 attach validation, I2, I3)

**Files:** `src/server/server.ts`, `src/server/trpc.ts`, `src/core/operations.ts`, `src/core/files.ts`, `src/saas/client.ts`, `src/index.ts`, tests.

### 4.1 — #6 + I2: comment-edit broadcast + normalization

- `server.ts` PATCH `/api/tasks/:id/comments/:commentId`: after successful `updateComment`, add `broadcast({ type: "tasks-updated" })` (same event the sibling add/delete use).
- `trpc.ts updateComment`: add `ctx.broadcast({ type: "tasks-updated" })` after success (matches `addComment`/`deleteComment` procedures).
- I2 normalization: add one helper in server.ts `broadcastTaskUpdated(broadcast, taskId?)` that emits `{ type: "tasks-updated", ...(taskId && { taskId }) }` and use it for comment add/edit/delete + file add/delete + screenshot routes. Do not change `task-changed`/`task-deleted` payloads (clients depend on them).

### 4.2 — #14: attach_file validation

- Move `isValidFilename` and `ALLOWED_FILE_EXTENSIONS` from `server/server.ts` to `core/files.ts` (export both); server.ts imports them (dedupe, single source).
- `core/operations.ts attachFile`:

  ```ts
  if (!isValidFilename(input.filename)) return { ok: false, error: { code: "INVALID_FILENAME", ... } };
  if (!ALLOWED_FILE_EXTENSIONS.has(extname(input.filename).toLowerCase())) return { ok: false, error: { code: "UNSUPPORTED_FILE_TYPE", message: "...", suggestion: "Allowed: png jpg jpeg gif webp pdf txt md json csv svg mp4 mov zip" } };
  ```

  then saveFile as today.

### 4.3 — I3: typed SaaS errors (saas/client.ts)

Replace `null`-on-any-failure returns with a discriminated result for the mutating/fetching calls used by CLI flows:

```ts
export type SaasResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status?: number } };
```

- `updateSaasTask` → `SaasResult<{ task: SaasTask; warning?: string }>`; `addSaasComment` → `SaasResult<SaasComment>`; `createSaasTask` → `SaasResult<SaasTask>`; `fetchSaasTasks` keeps `null` for "not authenticated" but gains an error channel for network-vs-HTTP distinction (e.g. return `SaasResult` too; CLI treats `!ok` with code `NOT_AUTHENTICATED` identically to today's null path).
- Update callers in `index.ts` (get/next/add/edit/list SaaS branches): map `error.code`/`message` into the existing chalk output + `outputError` JSON envelope instead of the generic "Unable to reach the online backend." Keep behavior for the unauthenticated case identical to today (same user-visible text).
- Phase 2's SaaS claim re-fetch uses the new error channel for its warning.

### Tests (Phase 4)

- `tests/unit/broadcast.test.ts` (e2e-style): boot server, open a WS client (the `ws` dep is available), PATCH a comment → assert a `tasks-updated` frame arrives (today: nothing). Same for tRPC `updateComment` via HTTP fetch to /trpc.
- `tests/unit/attach-file-validation.test.ts`: unit-test the new checks (invalid filename `../x.txt` → INVALID_FILENAME; `evil.exe` → UNSUPPORTED_FILE_TYPE; `report.md` passes) plus an e2e MCP-tool call through the mounted app returning the error envelope.
- Typed SaaS: unit tests with a stubbed `fetch` (vitest `vi.stubGlobal`) — success, HTTP 403, network throw → correct error codes; CLI output mapping test for one branch.

### Acceptance criteria

- Editing a comment via REST or tRPC updates connected WS clients.
- MCP `attach_file` cannot write `.exe`/traversal filenames; error codes match operations conventions.
- SaaS failures surface typed codes/messages instead of silent nulls; unauthenticated UX unchanged.
- tsc/build/tests green.

**Complexity:** M.

### Worker prompt — Phase 4 (copy-pasteable)

```bash
You are implementing Phase 4 of the vibeflow audit plan (/tmp/b5ed85db-impl-plan.md, repo /home/zorcec/workspace/vibeflow-workspace/vibeflow, package packages/cli). Phases 0-3 are committed (review gate, commit helper, PATCH whitelist).

Workflow: claim a task, implement, build + tests, changeset, commit, submit review.

Implement:
1. server/server.ts: PATCH /api/tasks/:id/comments/:commentId → broadcast({type:"tasks-updated"}) after success. Add broadcastTaskUpdated(broadcast, taskId?) helper and use it for comment add/edit/delete, file add/delete, screenshot routes (emit {type:"tasks-updated"} + optional taskId). Leave task-changed/task-deleted payloads untouched.
2. server/trpc.ts updateComment: add ctx.broadcast({type:"tasks-updated"}) on success.
3. Move isValidFilename + ALLOWED_FILE_EXTENSIONS from server/server.ts to core/files.ts (export); server.ts imports them. core/operations.ts attachFile: validate filename (INVALID_FILENAME) and extension (UNSUPPORTED_FILE_TYPE, suggestion lists allowed exts) BEFORE saveFile.
4. saas/client.ts: introduce SaasResult<T> = {ok:true,data}|{ok:false,error:{code,message,status?}} for updateSaasTask/addSaasComment/createSaasTask (fetchSaasTasks: NOT_AUTHENTICATED code for null-token case). Update all callers in src/index.ts to map error codes/messages into existing output + outputError envelope; keep the unauthenticated UX text identical to today. Phase 2's SaaS claim warning uses the new error channel.

Tests: WS broadcast test (boot server, connect ws, PATCH comment → tasks-updated frame; same for tRPC updateComment); attach-file validation unit + mounted-app MCP error envelope; stubbed-fetch SaaS result tests (success/403/network-throw) + one CLI output mapping test. Existing suites green.

Done when: tsc clean, build passes, tests green. Commit + changeset. Do NOT start Phase 5.
```

---

## Phase 5 — Push dry-run/orphans, MCP-from-manifest, server dedupe, verify cancellation (#4, I5, S1, S3, I4b)

**Files:** `src/commands/push.ts`, `src/core/operations.ts`, `src/mcp/manifest.ts`, `src/mcp/server.ts`, `src/server/server.ts`, `src/commands/verify.ts`, tests.

### 5.1 — #4 + I5: push dry-run + orphan cleanup

- `commands/push.ts`: signature → `push(dir, opts: { workspace?: string; keepLocalFiles?: boolean; dryRun?: boolean })`. When `dryRun`: list what would happen (N tasks, M files, target board) and **return before the import POST and before any deletion**. No network call in dry-run.
- `core/operations.ts pushTasks`: pass `dryRun: input.dryRun` through; when dry-run, return `{ ok: true, data: { dryRun: true, tasks: taskList.length, files }, steps: ["Dry run: no changes made"] }` (or surface push()'s preview result).
- CLI `push` command: add `--dry-run` flag mapping to opts (parity with tasks --dry-run).
- I5 orphan cleanup: in the deletion branch (only when `!keepLocalFiles && !dryRun`, after task files are unlinked), also remove the per-task asset dirs that are now orphaned: `getFilesDir(projectDir, task.id)` and `join(projectDir, PROTO_DIR, SCREENSHOTS_DIR, ...)` — use `rmSync(dir, { recursive: true, force: true })` guarded by a check that the task file is really gone. Count and log removed dirs.

### 5.2 — S1: MCP tools registered from manifest

- `mcp/manifest.ts`: change `input: z.ZodType` → `input: z.ZodRawShape`; set each entry's `input` to the `.shape` of the corresponding operations schema (e.g. `input: ListTasksInput.shape`).
- `mcp/server.ts createMcpServer`: replace all ten `server.tool(...)` blocks with:

  ```ts
  for (const tool of manifest) {
    server.tool(tool.name, tool.description, tool.input, async (input) => formatResult(await tool.run(ctx, input)));
  }
  ```

  Keep `formatResult` and the server metadata. Delete the duplicated zod enums (also removes ~6 more VALID_STATUSES duplicates). Verify the MCP SDK `server.tool` overload accepts a raw shape (it does: `server.tool(name, description, paramsSchema: ZodRawShape, cb)`).

### 5.3 — S3: serve()/serveApiOnly() dedupe

In `server/server.ts` extract the duplicated block (cors → security headers → json → `createServer` → `WebSocketServer` → broadcast fn → ping handler → listen/banner skeleton → close) into:

```ts
function createBaseServer(): { app: Express; httpServer: http.Server; wss: WebSocketServer; broadcast: BroadcastFn }
```

Both `serveApiOnly` and `serve` call it; route registration and mode-specific banner sections stay in place. Banner text must be byte-identical (tests snapshot or eyeball diff the startup output). Also mount `disposeMcp()` in the shared close path if Phase 0 put it only in serveApiOnly.

### 5.4 — I4b: verify cancellation

- `commands/verify.ts verifyTask(projectDir, taskId, opts: { json?, url?, signal?: AbortSignal })`:
  - `browser` launch guarded: if `signal?.aborted` before launch → throw `VerifyError("E_CANCELLED", ...)`.
  - After launch: `signal?.addEventListener("abort", () => { cancelled = true; void browser?.close(); }, { once: true })`; the pending `page.goto`/locator awaits reject → mapped to `E_CANCELLED`.
- `core/operations.ts verifyTaskOp`: create `AbortController`, `setTimeout(() => controller.abort(), timeoutMs).unref?.()`, pass `signal` into `verifyTask`; on abort return the existing `VERIFY_TIMEOUT` envelope (behavior-compatible, but the browser actually closes now).

### Tests (Phase 5)

- `tests/unit/push-dry-run.test.ts`: stub global fetch; `push(tmp, { dryRun: true })` performs zero fetch calls, zero deletions, prints preview; non-dry-run with keepLocalFiles=false deletes task files AND their orphaned `tasks/files/<id>` + screenshots dirs.
- `tests/unit/mcp-manifest.test.ts`: manifest tool count === 10; each tool name unique; every `input` is a ZodRawShape; mounted app responds to `tools/list` with all 10 names and descriptions equal to manifest (single source verified).
- `tests/unit/server-dedupe.test.ts`: boot both serve modes (API-only + static HTML file) on tmp projects — both respond on `/api/health`; startup banner output unchanged (capture console output, assert key lines still present).
- `tests/unit/verify-cancel.test.ts`: `verifyTaskOp` with `timeoutMs: 1000` against a task whose URL points at a never-responding server (hang) → returns VERIFY_TIMEOUT envelope and no chromium process leaks (assert via `browser` close spy or process count best-effort).

### Acceptance criteria

- `push_tasks` MCP tool and CLI `push --dry-run` make zero writes and zero network calls in dry-run; real push cleans orphaned asset dirs.
- `mcp/server.ts` has no per-tool zod re-declarations; manifest is the single source (tools/list matches).
- `serveApiOnly`/`serve` share `createBaseServer`; no duplicated ~80-line block; banners unchanged.
- Verify timeout actually cancels the browser.
- tsc/build/tests green; mutation suite (`pnpm mutation`) on changed core files has no new surviving mutants in lock/gate/claim logic.

**Complexity:** M–L (mostly mechanical, but 5.2/5.3 are refactors with behavioral-blast-radius risk; run full e2e after).

### Worker prompt — Phase 5 (copy-pasteable)

```bash
You are implementing Phase 5 (final phase) of the vibeflow audit plan (/tmp/b5ed85db-impl-plan.md, repo /home/zorcec/workspace/vibeflow-workspace/vibeflow, package packages/cli). Phases 0-4 are committed.

Workflow: claim a task, implement, build + unit + e2e tests, changeset, commit, submit review.

Implement:
1. commands/push.ts: add dryRun to opts; dry-run prints a preview (task count, file count, board) and returns BEFORE the import POST and any deletion. CLI push command gains --dry-run. core/operations.ts pushTasks passes input.dryRun through. Orphan cleanup: in the delete branch (!keepLocalFiles && !dryRun), after unlinking task files, rmSync each task's files dir (core/files.ts getFilesDir) and screenshot artifact when present; log counts.
2. mcp/manifest.ts: input becomes z.ZodRawShape (store `<Schema>.shape` per tool). mcp/server.ts: delete all ten server.tool blocks; register via a single loop over manifest (name, description, tool.input, handler → formatResult(await tool.run(ctx, input))). Keep formatResult + server metadata.
3. server/server.ts: extract createBaseServer() (cors, security headers, json, httpServer, wss, broadcast, ping handler) used by BOTH serveApiOnly and serve; ensure disposeMcp() is called in the shared close path. Startup banner output must remain byte-identical.
4. commands/verify.ts verifyTask: accept signal?: AbortSignal; abort before launch → E_CANCELLED VerifyError; after launch, abort closes the browser and surfaces E_CANCELLED. core/operations.ts verifyTaskOp: wire an AbortController to timeoutMs (unref'd) and pass the signal; keep the VERIFY_TIMEOUT envelope.

Tests: push dry-run (zero fetch/zero deletes via stubbed fetch) + orphan-dir cleanup test; manifest test (10 tools, unique names, ZodRawShape, tools/list matches manifest); both serve modes boot + /api/health + banner-line assertions; verify cancellation test (timeoutMs=1000 vs hanging URL → VERIFY_TIMEOUT, browser closed).

Done when: tsc clean, pnpm build passes, pnpm test AND pnpm test:e2e green. Commit + changeset. This is the last phase — after commit, submit for review.
```

---

## Gaps (could not be fully closed from this repo)

- **SaaS-side claim atomicity:** the backend (`app.vibeflow.tools` / `VIBEFLOW_API_URL`) is a separate codebase; true compare-and-swap for `PATCH /api/cli/tasks/:id` (e.g. `expectedStatus: "todo"` precondition) must be implemented server-side. Phase 2 ships best-effort client-side (author capture + post-update verification warning). Next step: open a SaaS-repo task for an `expectedStatus` precondition on PATCH.
- **Kanban/overlay UI consumers of PATCH:** the whitelist (Phase 3) intentionally drops undocumented keys; before shipping, smoke-test the kanban UI drag flows to confirm no UI feature relied on a key outside the whitelist (e.g. `screenshot` — if the UI sets it via PATCH, add it to the whitelist after verifying).
- **`onTaskRefClick` location:** the overlay React source path couldn't be confirmed without directory listing from this planning session (no shell access); Phase 0 worker locates it by grep before deleting.
- **Server-side SaaS tests** for `/api/cli/import` behavior are out of scope (different repo).

## Sources / evidence index (file → finding)

- `packages/cli/src/core/tasks.ts` — `VALID_STATUSES` dup (S2); `updateTask` spread-overwrite (`author: undefined`, #1); RMW without lock (#13).
- `packages/cli/src/core/operations.ts` — claimNextTask inline `priorityOrder` no tie-break (S5, #1); `ctx.userId` undefined (#1); `updateTask` op missing gates/verified-reset (S-parity #3); `pushTasks` drops `dryRun` (#4); `attachFile` no validation (#14).
- `packages/cli/src/index.ts` — `--next` local/SaaS claim races + no author (#1); edit-path gates to extract (#3); commit logic duplicated (#3); `getPriorityRank` (S5); `VALID_STATUSES` + inline arrays (S2).
- `packages/cli/src/server/server.ts` — PATCH mass-assignment + no gates (#2); upload double-decode (#7); `requireSameOrigin` prefix hole (#8); `/api/project` no gitUserName (#10); comment PATCH no broadcast (#6); `serveApiOnly`/`serve` duplication (S3); `isValidFilename`/`ALLOWED_FILE_EXTENSIONS` to move (#14).
- `packages/cli/src/server/trpc.ts` — `updateComment` no broadcast (#6); inline status enum (S2).
- `packages/cli/src/mcp/server.ts` — 10 tools re-declared (S1); ctx without userId (#1).
- `packages/cli/src/mcp/manifest.ts` — claims single source of truth; `input: z.ZodType` (S1).
- `packages/cli/src/mcp/auth.ts` — dead loopback check, `!==` compare, 30s cache (#15, I6).
- `packages/cli/src/mcp/http.ts` — `createdAt`-based reaper, global interval, signal-handler accumulation (#9).
- `packages/cli/src/commands/verify.ts` — hardcoded 3700 (#11); verified persistence already fixed (excluded); no cancellation (I4b).
- `packages/cli/src/commands/push.ts` — no dryRun; unlink loop without cleanup (#4, I5).
- `packages/cli/src/core/comments.ts` — RMW races (#13); `getCommentCount` dead (S4).
- `packages/cli/src/core/files.ts` — `migrateLegacyLinkedRefs` on read paths (#12).
- `packages/cli/src/core/gating.ts` — `canMoveToReview` dead (S4).
- `packages/cli/src/core/types.ts`, `core/config.ts`, `core/git-user.ts`, `saas/client.ts` — targets for consolidation, author capture, typed errors.
