# Research: Test-gap implementation plan — e2e/Playwright coverage for session bugfixes

> Deliverable note: this file IS the plan (~200–350 lines). Parent should `cp` it to
> `/tmp/test-gap-plan.md` before launching Budget workers (workers reference that path).

## Summary
The already-designed 8-file MCP e2e suite (`vibeflow/docs/specs/mcp-e2e-test-plan.md`) is implementable as 3 sequential Budget sessions in the public repo, but three plan-doc assumptions are now stale: **Phase 2 atomic claim + MCP author wiring has landed** (flips assert ON), **WP-1 attach validation has landed** (error envelopes are now deterministic, no "pin after first run"), and **WP-3 update_task gates have NOT landed** (`GATED=false` stands, one-line flip later). In the private web repo, verified source shows the upload route **coerces** (does not reject) `text/javascript`, rate limits are untriggerably relaxed in e2e (limit 10,000/min under `E2E_TEST=true`), and file-disposition tests require MinIO — all handled explicitly in the briefs below.

## Verified ground truth (read directly from source, 2026-02 session state)
1. **Phase 2 claim atomicity LANDED** — `claimNextTaskAtomic` in `packages/cli/src/core/tasks.ts` + `tests/unit/claim.test.ts` (8 passing unit scenarios incl. two-sequential-claims skip logic). `core/operations.ts claimNextTask` delegates to it with `author: ctx.userId`; `src/mcp/server.ts createMcpServer` sets `ctx.userId = getGitUser(projectDir).name`; `src/index.ts` imports `claimNextTaskAtomic` + `getGitUser` for the CLI `--next` path. → All `[Phase 2] flip` markers in the spec doc must be implemented as **assert-on**.
2. **WP-1 attach validation LANDED** — `core/files.ts` exports `validateFilename`/`isAllowedFileExtension`/`isValidFilename` (rejects separators, `..`, null/control bytes, leading dots, >255 chars) and `core/operations.ts attachFile` gates **before** `saveFile`, surfacing error codes **`INVALID_FILENAME`**, **`UNSUPPORTED_FILE_TYPE`**, **`VALIDATION`** (oversize) directly as the envelope `error` code; only unexpected throws fall back to `ATTACH_FILE_ERROR`.
3. **WP-3 update_task gates NOT landed** — `core/operations.ts updateTask` still has no review-comment gate and no verified-reset; comment is added after update. `const GATED = false` + flip helper from spec §2.4 stands.
4. **Web upload route** (`packages/web/src/app/api/tasks/[taskId]/files/route.ts`): POST accepts multipart or raw body; `text/javascript` is **not rejected** — it is rewritten to `application/octet-stream` and stored (BLOCKED_MIME_TYPES → coercion). Auth via `resolveUserId` + board membership; empty → 400; >5MB → 413.
5. **Web download route** (`.../files/[fileId]/route.ts`): SVG + HTML are `PRESIGN_BLOCKED` → always proxied with `contentDispositionFor()` (`src/server/storage/disposition.ts`: `INLINE_SAFE` = png/jpeg/gif/webp/pdf → `inline`, everything else → `attachment`) + `X-Content-Type-Options: nosniff`. Test env has no `STORAGE_PUBLIC_ENDPOINT` → proxy path deterministic.
6. **Overlay auth** (`src/app/api/overlay/tasks/route.ts`): missing or wrong `X-Overlay-Api-Key` → **401** (sha256 + timingSafeEqual vs `boards.overlayApiKey`); raw key is only obtainable via tRPC `workspace.regenerateOverlayApiKey` (owner/admin); POST without kanban board → 422; `workspace.createWithBoard` returns `{board, kanbanBoard}` so the 422 path is avoided.
7. **Rate limits relaxed in every e2e run** — `isRateLimitRelaxed()` = `NODE_ENV !== "production" || E2E_TEST === "true"`; both the Playwright webServer (`NODE_ENV=test`, `E2E_TEST=true`) and docker `app-test` set these → overlay limit 10,000/min, tRPC 10,000/min. **A 429 burst cannot be triggered in Playwright e2e.** → Brief B3 = documented skip, no spec.
8. **Storage backend** — `src/server/storage/client.ts` requires `STORAGE_PROVIDER` (+ endpoint/keys); test compose (`vibeflow-private/docker-compose.test.yml`) ships `minio-test` (minioadmin/minioadmin, bucket `vibeflow-files-test`) but exposes **no host port** and the Playwright config's webServer env sets no STORAGE_* vars → local uploads would 502. Brief B1 fixes this with a config-level change.
9. Public e2e runs on vitest (`vitest.e2e.config.ts`: include `tests/e2e/**/*.test.ts`, 30s test timeout, pool forks min 4/max 8 — module-scope MCP session map is per-fork; `stopMcpForTests()` still mandatory).

---

## Section 1 — PUBLIC repo: MCP e2e suite worker briefs

Spec of record: `/home/zorcec/workspace/vibeflow-workspace/vibeflow/docs/specs/mcp-e2e-test-plan.md` (authoritative for helpers §1.1, scenario catalog §2, run strategy §5, caveats §6). Workers MUST read it first. All files in `/home/zorcec/workspace/vibeflow-workspace/vibeflow/packages/cli/tests/e2e/`. Tests only — never touch `packages/cli/src/`.

**Deltas vs the spec doc (apply everywhere, they override the doc):**
- `[Phase 2]` claim flips are **ON**: racer scenarios assert `r1.task.id !== r2.task.id`; MCP claim asserts `author` equals the configured git user name (seed `git init` + `git config user.name "E2E User"` in the tmp project).
- Attach-file error cases assert **deterministic envelopes**: `../escape.md`, `sub/dir.md`, `"a\u0000b.md"`, `"a\u0001b.md"`, `.hidden.md` → `error === "INVALID_FILENAME"`; `"evil.exe"` → `error === "UNSUPPORTED_FILE_TYPE"`; keep the recursive-scan hard assert (nothing written outside `.vibeflow/tasks/files/<id>/`).
- Gate matrix stays `const GATED = false;` with the `// [Phase 3] flip` helper verbatim from spec §2.4 (dependency: WP-3).
- Reaping: only `getSessionCount()` bookkeeping + `disposeMcp()` lifecycle (spec §2.7 scenarios 1/2/4). Do NOT implement the aging test.

### Session P1 — helpers + transport + tools (commit 1)
```bash
cd /home/zorcec/workspace/vibeflow-workspace/vibeflow/packages/cli
pnpm run prebuild && pnpm run build   # tests spawn dist/index.js (init.test.ts pattern)
```
1. Create `tests/e2e/mcp-helpers.ts` exactly per spec §1.1: `bootMcpServer()` (in-process `serve(undefined, { port: getFreePort(), open: false, projectDir: <mkdtemp>, _testToken: null, _testWorkspace: null })` — the API-only boot pattern of `tests/e2e/serve.test.ts`; `_testToken:null/_testWorkspace:null` are load-bearing: without them a dev machine's real token flips the server to SaaS mode and MCP is not mounted), `getFreePort()` (node:net listen(0), retry once on EADDRINUSE; never use serve.test.ts's fixed 3750+ ports), fetch-based `McpClient` (`initialize` → `mcp-session-id` header → `notifications/initialized` expect 202 → `listTools`/`callTool`), `assertJsonTextContent()` (HTTP 200; `content[0].text` is a string that parses as JSON — the TextContent contract), `isolatedEnv()/runCli()/spawnApiServer()` (spawn `node ${join(process.cwd(),"dist","index.js")} serve --no-open -p <port>` with `HOME=<tmpHome>`, `VIBEFLOW_TELEMETRY=0`; prefer `serve` over `kanban` — no update check). Set `process.env.VIBEFLOW_TELEMETRY = "0"` at file top. Every cleanup: `instance.close()` + `rmSync` temp dirs + `stopMcpForTests()` (exported from `src/mcp/http.ts`).
2. Create `tests/e2e/mcp-transport.test.ts` — spec §2.1 scenarios 1–15 (protocol version echo, serverInfo `vibeflow`/`0.1.0`, notifications 202, tools/list exactly 10, DELETE → `{ok:true}` then reuse → 404 `{"error":"Session not found"}`, DELETE/GET without session id → 400, unknown session id POST/GET → 404, no-session non-initialize POST → clean rejection not 500 (pin observed status after first run), 2 concurrent clients + `getSessionCount() === 2`, OPTIONS → 204 with `Access-Control-Allow-Origin: http://localhost:3700` fixed and `mcp-session-id`+`Authorization` in allow-headers, cross-instance session id → 404 via spawned second process). Never assert 500 anywhere.
3. Create `tests/e2e/mcp-tools.test.ts` — spec §2.2, all 10 tools, exact payloads from spec §3; per tool assert parsed text **and** on-disk effect (`.vibeflow/tasks/**/<id>.json`, `.vibeflow/tasks/files/<id>/<filename>`). Overrides: scenario 7 claim — assert `author` is set (git user seeded, or non-empty string when no git user) instead of "author NOT set"; scenario 15 push envelope-only test and scenario 16 mock-SaaS push exactly per spec (never push without token in-process — device login opens a browser); verify_task only E_NOT_FOUND/E_NO_BASELINE envelopes (no browser).
4. Iterate: `npx vitest run --config vitest.e2e.config.ts tests/e2e/mcp-transport.test.ts tests/e2e/mcp-tools.test.ts` until green.
5. Commit: `git add tests/e2e/mcp-helpers.ts tests/e2e/mcp-transport.test.ts tests/e2e/mcp-tools.test.ts .changeset/ && git commit -m "test(cli): MCP e2e — helpers, transport/session lifecycle, tool happy paths"`. Add a changeset: patch bump for `@vibeflow-tools/cli` (repo rule: every change ships a changeset in the public repo).

### Session P2 — errors + auth + hang + claim-race + parity (commit 2)
Runs AFTER Session P1 is committed. Same repo/cwd/build already done.
1. `tests/e2e/mcp-errors.test.ts` — spec §2.3 all 15 cases + §2.4 gate matrix with `GATED=false` helper. Overrides: attach_file cases assert `INVALID_FILENAME`/`UNSUPPORTED_FILE_TYPE` envelopes (WP-1 landed; see Deltas); invariants: HTTP never 5xx, body parses, server usable after each error; case 14 malformed JSON → 400; case 15 missing Accept → 400/406 (pin after first run).
2. `tests/e2e/mcp-auth.test.ts` — spec §2.6 with HOME-isolated **spawned** server: loopback no-token → 200 full handshake; write `tmpHome/.vibeflow/auth.json {"token":"s3cr3t-e2e"}` → no Bearer 401, wrong Bearer **403**, valid Bearer 200 + tools/list; non-loopback via `serve --host 0.0.0.0` + LAN IPv4 from `networkInterfaces()` with `test.skip` when no LAN IPv4 (skip reason in report); X-Forwarded-For forging ignored (no trust proxy) → still 401. Never boot auth tests without HOME isolation.
3. `tests/e2e/mcp-hang.test.ts` — spec §2.9: spawned `tasks <tmp> --add --title "hang probe" --json` with no server exits 0 in <3000ms and parses `{success:true,...}`; `--next --json` empty board <3000ms non-JSON stdout (guard `stdout.trim().startsWith("{")`); `tasks <tmp> --json` list <3000ms parses. **Grep `tests/e2e/` first — if a Phase-1 hang file already exists, extend it, don't duplicate.**
4. `tests/e2e/mcp-claim-race.test.ts` — spec §2.5 with flips ON: two spawned `tasks <tmp> --next --json` racers via `Promise.all` on one HOME-isolated tmp project (seeded flat-layout tasks with distinct priorities) → both exit 0, both stdout parse as JSON, **`r1.task.id !== r2.task.id`**, exactly one `in-progress` per racer, `author` non-empty (git user seeded); two concurrent MCP `claim_next_task` calls on one in-process server → different ids, `author` set; single `--next` on empty board prints non-JSON plain text exit 0.
5. `tests/e2e/mcp-parity.test.ts` — spec §2.8: tools/list names sorted === sorted `manifest` names (import from `../../src/mcp/manifest.js`), descriptions equal, light schema check (one invalid documented field per tool → `-32602`), soft inputSchema-key parity table + `annotations === undefined` with `// [Phase 5] flip` notes.
6. Iterate per file, then commit: `git add tests/e2e/mcp-*.test.ts && git commit -m "test(cli): MCP e2e — error paths + gate matrix, auth, hang, claim race, manifest parity"`.

### Session P3 — full-suite verification (commit 3 only if fixes needed)
```bash
cd /home/zorcec/workspace/vibeflow-workspace/vibeflow/packages/cli
pnpm run prebuild && pnpm run build
pnpm test          # unit suite (vitest run)
pnpm run test:e2e  # full e2e incl. all mcp-*.test.ts
```
Green criteria: every new/edited `mcp-*.test.ts` passes; no NEW unit or e2e failure. The 13 pre-existing `Cannot find package` failures (b577d93e) are known-ignored and NOT blocking — workers must not "fix" them and must not let them mask new failures: classify any failure with `Cannot find package` in the message as pre-existing; everything else must be fixed or traced to the new files and fixed. Fix regressions caused by the new suite (port collisions, module-state leaks) in the test files only; commit `test(cli): MCP e2e suite — full-suite fixes`.

## Section 2 — PRIVATE repo: Playwright spec briefs

Repo: `/home/zorcec/workspace/vibeflow-workspace/vibeflow-private/packages/web`. Reuse `tests/e2e/fixtures.ts` (extended `test` with console-error/5xx guards — import `test, expect` from `./fixtures`, NOT `@playwright/test`), `tests/e2e/helpers.ts` (`registerUser`, `signInUser`, `uniqueEmail`), `global-setup.ts` `_test`-DB guard. DB must end `_test`. **`ls tests/e2e/` first** — if a files/upload spec already exists, extend it instead of creating B1's file. Commits: conventional, no changesets (web-only).

### Brief B1 — `tests/e2e/file-disposition.spec.ts` (new) + storage config
Config pre-step (part of this brief):
- `docker-compose.test.yml`: add `ports: ["9000:9000"]` to `minio-test` so local runs can reach it.
- `playwright.config.ts`: add to webServer `env`: `STORAGE_PROVIDER: process.env.STORAGE_PROVIDER ?? "s3compat"`, `S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000"`, `S3_ACCESS_KEY: "minioadmin"`, `S3_SECRET_KEY: "minioadmin"`, `STORAGE_BUCKET: "vibeflow-files-test"`. Also add the same vars to the `playwright` service env in `docker-compose.test.yml` (for in-docker runs the app already has them; harmless duplication).
- Local run precondition: `docker compose -f /home/zorcec/workspace/vibeflow-workspace/vibeflow-private/docker-compose.test.yml up minio-test -d`.
Spec (test.describe "task file disposition — XSS hardening"):
1. `registerUser(page)` → `page.request.post("/api/trpc/workspace.createWithBoard", { data: { json: { name: "Disp WS", slug: \`disp-${Date.now()}\` } } })` → `board = body.result.data.json.board`, `kb = ...kanbanBoard` → `page.request.post("/api/trpc/task.create", { data: { json: { workspaceId: board.id, boardId: kb.id, title: "File disp task" } } })` → `taskId`.
2. SVG: upload `page.request.post(\`/api/tasks/${taskId}/files\`, { multipart: { file: { name: "xss.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') } } })` → expect ok; `GET` the returned `file.url` via `page.request` (shares session cookies) → expect 200; `content-disposition` starts with `attachment;`; `x-content-type-options` === `nosniff`; `content-type` === `image/svg+xml`.
3. PNG: upload 1×1 PNG buffer (`mimeType: "image/png"`) → download `content-disposition` starts with `inline;`.
4. `text/javascript`: upload `mimeType: "text/javascript"` → upload **succeeds** but response `file.mimeType === "application/octet-stream"` (route coerces — verified); download `content-type` !== `text/javascript` and `content-disposition` starts `attachment;`. Include `// FLIP: if upload route switches to rejecting blocked MIME (415/400), change this to expect rejection` — coordinate with any in-flight WP touching this route.
5. Auth guard (cheap): same `GET file.url` via the bare `request` fixture (no session) → 401.
Verification:
```bash
cd /home/zorcec/workspace/vibeflow-workspace/vibeflow-private/packages/web
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/spota_test npx playwright test tests/e2e/file-disposition.spec.ts
```
Commit: `test(web): task-file Content-Disposition + nosniff e2e coverage; wire test storage env`.

### Brief B2 — `tests/e2e/overlay-auth.spec.ts` (new; do NOT extend overlay.spec.ts)
1. Missing key: bare `request.post("/api/overlay/tasks", { data: { boardId: "nonexistent", title: "x" } })` → **401**, `body.error` truthy. Same for `request.get("/api/overlay/tasks?boardId=nonexistent")` → 401.
2. Wrong key: register user → `workspace.createWithBoard` (as in B1) → POST with header `"X-Overlay-Api-Key": "wrong-key"` → 401.
3. Valid key: `page.request.post("/api/trpc/workspace.regenerateOverlayApiKey", { data: { json: { workspaceId: board.id } } })` → `rawKey = body.result.data.json.overlayApiKey` (only place the raw key is returned; registering user is owner → allowed) → POST `/api/overlay/tasks` with header `rawKey`, data `{ boardId: board.id, title: "Overlay auth task", status: "todo" }` → 200 `{ success: true }`; `GET /api/overlay/tasks?boardId=${board.id}` with header → 200, `tasks` array contains the title.
4. Expect `createWithBoard`'s auto-created `kanbanBoard` to prevent the 422 no-board path.
Verification: `cd /home/zorcec/workspace/vibeflow-workspace/vibeflow-private/packages/web && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/spota_test npx playwright test tests/e2e/overlay-auth.spec.ts`.
Commit: `test(web): overlay API X-Overlay-Api-Key auth e2e coverage`.

### Brief B3 — rate-limit smoke: SKIP (documented)
`isRateLimitRelaxed()` returns true in every e2e run (`NODE_ENV=test` and `E2E_TEST=true` in the webServer env, and `E2E_TEST=true` in docker `app-test`), raising the overlay limit to 10,000/min and tRPC to 10,000/min. A 429 burst is therefore untriggerable in Playwright against the test server; forcing it would require production-mode boot (slow, flaky, out of scope). 429 logic is already unit-testable (`inMemoryLimit` is pure) — if coverage is wanted later, add a vitest unit test, not a Playwright spec. No code, no commit.

## Section 3 — Execution order, dependencies, verification

| Order | Brief | Repo | Waits for | Commit |
|---|---|---|---|---|
| 1 | P1 helpers+transport+tools | public `packages/cli` | current public workers (Batch B public + WP-1, already landed) finish | 1 |
| 2 | P2 errors+auth+hang+claim-race+parity | public `packages/cli` | P1 | 1 |
| 3 | P3 full-suite verification | public `packages/cli` | P2 | 0–1 |
| 4 | B1 file-disposition + storage env | private `packages/web` | Batch B private part lands | 1 |
| 5 | B2 overlay-auth | private `packages/web` | Batch B private part lands (independent of B1, may parallel) | 1 |
| 6 | B3 rate-limit | — | — | skip, documented |
| later | Gate-matrix flip | public `packages/cli` | WP-3 lands → set `GATED=true` in `mcp-errors.test.ts`, flip 5 assertions per spec §2.4 | 1 |

Verification commands (exact):
- Public: `cd /home/zorcec/workspace/vibeflow-workspace/vibeflow/packages/cli && pnpm run prebuild && pnpm run build && pnpm test && pnpm run test:e2e`. Green = all `mcp-*.test.ts` pass, no new failures anywhere; the 13 pre-existing `Cannot find package` failures (b577d93e) are ignored/not blocking — never count them as regressions, never fix them in these briefs, and never let a new failure hide behind them.
- Private: `docker compose -f /home/zorcec/workspace/vibeflow-workspace/vibeflow-private/docker-compose.test.yml up postgres-test supabase-realtime-test minio-test -d` then `cd /home/zorcec/workspace/vibeflow-workspace/vibeflow-private/packages/web && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/spota_test pnpm run test:e2e`. Green = full Playwright suite (incl. B1/B2) passes against the `_test` DB; global-setup hard-aborts on any non-`_test` DATABASE_URL, which is the safety net. The public-repo `Cannot find package` failures cannot affect Playwright (separate repos/processes).

## Sources
- Kept: `vibeflow/docs/specs/mcp-e2e-test-plan.md` — authoritative 8-file suite design, helpers, scenario catalog, caveats.
- Kept: `vibeflow/packages/cli/src/{mcp/server.ts, core/operations.ts, core/files.ts, core/tasks.ts, index.ts}`, `tests/unit/claim.test.ts`, `vitest.e2e.config.ts`, `tests/e2e/serve.test.ts` — verified landed state (Phase 2, WP-1) and boot patterns.
- Kept: `vibeflow-private/packages/web/src/app/api/tasks/[taskId]/files/**`, `src/server/storage/{disposition,client,operations}.ts`, `src/app/api/overlay/tasks/route.ts`, `src/server/trpc/{routers/workspace.ts,routers/task.ts,router.ts}`, `src/server/rate-limit.ts`, `playwright.config.ts`, `tests/e2e/{fixtures,helpers,global-setup}.ts`, `docker-compose.test.yml`, `packages/shared/src/schemas.ts` — verified web behaviors, fixtures, storage/rate-limit facts.
- Dropped: plan-doc `[Phase 2]`/attach-file "pin after first run" assumptions — superseded by verified source; workers get explicit deltas instead.

## Gaps
- Exact list of the 36 private e2e spec filenames was not enumerable (no shell in this session); briefs instruct workers to `ls tests/e2e/` and extend an existing files/upload spec if one exists.
- Whether the CLI `--next` JSON output includes `author` top-level is inferred from imports (`claimNextTaskAtomic` + `getGitUser` in `src/index.ts`), not read line-by-line; Session P2 worker should confirm with one grep and weaken to "non-empty string" only if absent.
- Pre-existing "Cannot find package" failure inventory (which 13 tests, which repo config) not re-derived; handled purely by classification rule, per the task's "ignored, not blocking" directive.

## Supervisor coordination
No blocking decisions needed — plan is complete and self-contained; returning the brief normally.
