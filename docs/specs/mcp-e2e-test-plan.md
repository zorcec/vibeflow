# MCP e2e Test Suite — vibeflow CLI (`packages/cli`)

Plan written 2026-02-13 after reading `src/mcp/{http,auth,server,manifest}.ts`, `src/core/{operations,tasks,files,types}.ts`, `src/server/server.ts`, `src/commands/{push,verify}.ts`, `src/auth/{token,login}.ts`, `src/index.ts`, `src/telemetry.ts` and the existing test infra (`vitest.config.ts`, `vitest.e2e.config.ts`, `tests/e2e/{serve,init}.test.ts`, `tests/unit/mcp/{tools,drift,auth}.test.ts`).

Phase markers: `[now]` = assert current behavior; `[Phase N]` = behavior will change — strategy documented inline (implement now + TODO flip, or feature-detect).

---

## 1. Test file structure

All files live in `packages/cli/tests/e2e/` and match the existing `*.test.ts` naming (e2e config include is `tests/e2e/**/*.test.ts` — NOT `.spec.ts`):

```
tests/e2e/
  mcp-helpers.ts           # shared boot + MCP client helpers (NOT a test file; no .test.ts suffix)
  mcp-transport.test.ts    # session lifecycle: initialize, tools/list, DELETE, session reuse, concurrent sessions
  mcp-tools.test.ts        # all 10 tools happy path over HTTP + on-disk effects + TextContent JSON contract
  mcp-errors.test.ts       # unknown tool, invalid args, nonexistent ids, bad filenames, claim empty board, gate matrix
  mcp-auth.test.ts         # loopback/no-token, non-loopback, Bearer matrix (spawned server, HOME-isolated)
  mcp-claim-race.test.ts   # two spawned `tasks --next --json` racers + spawned-server cross-instance session [Phase 2-aware]
  mcp-parity.test.ts       # tools/list parity vs manifest [Phase 5-aware]
  mcp-hang.test.ts         # CLI one-shot regression: `tasks --add --json` with no server exits <3s (plan Phase 1 e2e)
```

### 1.1 Helpers (`mcp-helpers.ts`)

**A. Boot: in-process API-only server (mirrors `tests/e2e/serve.test.ts` "API-only mode" describe).**

MCP is mounted **only** in API-only mode — `serveApiOnly()` in `src/server/server.ts` calls `mountMcp(app, projectDir, "local")`; the HTML-file `serve(target, ...)` path does **not** mount MCP. Reuse the exact existing boot pattern from `serve.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ServeInstance } from "../../src/server/server.js";
const { serve } = await import("../../src/server/server.js"); // dynamic import AFTER HOME override (see mcp-auth)

export async function bootMcpServer(): Promise<{
  instance: ServeInstance;
  baseUrl: string;      // instance.url
  mcpUrl: string;       // instance.url + "/api/mcp"
  projectDir: string;   // mkdtemp temp project
  cleanup: () => Promise<void>;
}> {
  const projectDir = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
  const port = await getFreePort();
  const instance = await serve(undefined, {
    port,
    open: false,
    projectDir,
    // @internal test hooks — force OFFLINE mode deterministically:
    // without them the server reads the REAL ~/.vibeflow/token and silently
    // boots in SaaS mode (local API 503, MCP not mounted at all).
    _testToken: null,
    _testWorkspace: null,
  } as never); // cast needed: ServeOptions marks _testToken/_testWorkspace @internal
  return {
    instance, projectDir,
    baseUrl: instance.url,
    mcpUrl: instance.url + "/api/mcp",
    async cleanup() {
      await instance.close();
      rmSync(projectDir, { recursive: true, force: true });
      stopMcpForTests(); // clear module-scope sessions Map + reaper interval (mcp/http.ts export)
    },
  };
}
```

Facts backing this helper:
- `serveApiOnly(projectDir, options)`: `token = options._testToken === undefined ? await readToken() : options._testToken` — passing `null` short-circuits the real-token read (`src/auth/token.ts` reads `~/.vibeflow/token` with no env override).
- `mountMcp` is called **only** inside the `else` (offline) branch of `serveApiOnly`; online mode 503s `/api/tasks` and skips MCP.
- `mountMcp` keeps a **module-scope** `sessions` Map and a `reaper` interval (5 min sweep, 30 min TTL, `unref()`d). `src/mcp/http.ts` exports: `disposeMcp()`, `getSessionCount()`, `clearSessions()`, `stopMcpForTests()` (= `disposeMcp()`). Call `stopMcpForTests()` in every cleanup — sessions from one test would otherwise leak into the next because the map is shared across `serve()` instances in the same fork.

**B. Random port allocation (no fixed ports, no collision with a running dev server on 3700).**

```ts
import { createServer } from "node:net";
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = (srv.address() as { port: number });
      srv.close(() => resolve(port)); // tiny TOCTOU race; acceptable, retry-on-EADDRINUSE at boot
    });
    srv.on("error", reject);
  });
}
```

Do NOT copy serve.test.ts's fixed ports (3750…9726) — the new suite runs in parallel forks and collides with any running instance.

**C. Minimal MCP client over `fetch` (initialize → session id → tools/list/call wrapper).**

```ts
// Protocol version to request. Assert the server echoes it back.
const PROTOCOL_VERSION = "2025-06-18";

export function jsonRpcBody(id: number, method: string, params?: unknown): unknown {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

export interface McpClient {
  mcpUrl: string;
  token?: string;          // Bearer token for auth tests (undefined = no header)
  sessionId?: string;      // set after initialize; attach as mcp-session-id header
  nextId: number;
}

async function mcpFetch(c: McpClient, body: unknown, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
    ...(c.sessionId ? { "mcp-session-id": c.sessionId } : {}),
  };
  return fetch(c.mcpUrl, { ...init, method: init.method ?? "POST", headers: { ...headers, ...(init.headers as object) },
    body: init.body ?? JSON.stringify(body) });
}

export async function initialize(c: McpClient, protocolVersion = PROTOCOL_VERSION): Promise<Response> {
  const res = await mcpFetch(c, jsonRpcBody(1, "initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "mcp-e2e-client", version: "0.0.0" },
  }));
  if (res.ok) {
    c.sessionId = res.headers.get("mcp-session-id") ?? undefined;
    // Step 2 of the handshake — the client MUST notify, then the session is usable.
    const res2 = await mcpFetch(c, { jsonrpc: "2.0", method: "notifications/initialized" });
    // enableJsonResponse:true → notification POST returns 202 with empty body
    if (res2.status !== 202) throw new Error(`notifications/initialized returned ${res2.status}`);
  }
  return res;
}

export async function callTool(c: McpClient, name: string, args: Record<string, unknown>): Promise<Response> {
  const id = ++c.nextId;
  return mcpFetch(c, jsonRpcBody(id, "tools/call", { name, arguments: args }));
}

export async function listTools(c: McpClient): Promise<Response> {
  const id = ++c.nextId;
  return mcpFetch(c, jsonRpcBody(id, "tools/list", {}));
}

/** The verify_task TextContent contract bug class: every ok response's content[0].text
 *  MUST be a defined string that parses as JSON. */
export async function assertJsonTextContent(res: Response): Promise<unknown> {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.error).toBeUndefined();
  const text = body.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");           // the contract — catches JSON.stringify(undefined) === undefined
  expect(() => JSON.parse(text as string)).not.toThrow();
  return JSON.parse(text as string);
}

export function newClient(mcpUrl: string, token?: string): McpClient {
  return { mcpUrl, token, nextId: 1 };
}
```

`beforeEach`/`afterEach` per test file:

```ts
let env: Awaited<ReturnType<typeof bootMcpServer>>;
let client: McpClient;
beforeEach(async () => { env = await bootMcpServer(); client = newClient(env.mcpUrl); });
afterEach(async () => { await env.cleanup(); });
```

**D. HOME-isolated spawn helper (for `mcp-auth`, `mcp-claim-race`, `mcp-hang`).**

Why: several code paths read the **real** `$HOME/.vibeflow` (MCP bearer token `~/.vibeflow/auth.json` in `mcp/auth.ts` — read per request, dynamically; SaaS token `~/.vibeflow/token` in `auth/token.ts`; SaaS `login()` device-flow). Node's `os.homedir()` returns `$HOME` on POSIX, so `spawn` with `env: { ...process.env, HOME: tmpHome, VIBEFLOW_TELEMETRY: "0" }` fully isolates auth state and SaaS mode. (`src/telemetry.ts` documents this exact override pattern: "Lazy helpers so tests can override HOME via process.env.HOME before importing this module".)

```ts
import { spawn, execFile } from "node:child_process";
const CLI = join(process.cwd(), "dist", "index.js"); // same binary path as tests/e2e/init.test.ts

export function isolatedEnv(tmpHome: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: tmpHome, VIBEFLOW_TELEMETRY: "0" };
}

export function runCli(args: string[], opts: { cwd: string; home: string; timeoutMs?: number }):
  Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null; elapsedMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { cwd: opts.cwd, encoding: "utf-8", timeout: opts.timeoutMs ?? 15_000,
      env: isolatedEnv(opts.home) }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ stdout, stderr, code, signal: null, elapsedMs: Date.now() - start });
    });
  });
}

/** Boots `serve` (API-only, no positional target ⇒ projectDir = cwd) with MCP mounted. */
export function spawnApiServer(opts: { cwd: string; home: string; port: number }): { child: ChildProcess; mcpUrl: string; waitReady: Promise<void> } {
  const child = spawn("node", [CLI, "serve", "--no-open", "-p", String(opts.port)], { cwd: opts.cwd, env: isolatedEnv(opts.home) });
  // "serve" (unlike "kanban") does NOT run checkForUpdates() — no outbound non-loopback request.
  const waitReady = waitFor(instanceUrlLine, /* poll GET http://127.0.0.1:port/api/pages until 200 */);
  return { child, mcpUrl: `http://127.0.0.1:${opts.port}/api/mcp`, waitReady };
}
```

Boot choice: `serve --no-open` (not `kanban`) for spawned boots — `kanban` fires a non-blocking `checkForUpdates()` which may make one outbound request (violates the loopback-only rule); `serve` has no update check. Telemetry: `VIBEFLOW_TELEMETRY=0` disables PostHog in every spawned process (`src/telemetry.ts isTelemetryEnabled()`).

**E. On-disk layout facts for assertions.**

- `PROTO_DIR = ".vibeflow"`, tasks at `<projectDir>/.vibeflow/tasks/` — either flat `<id>.json` or date-subdir `<created-slice(0,10)>/<id>.json` (both layouts are read; `updateTask` writes to the date layout and removes the old flat file).
- Files: `<projectDir>/.vibeflow/tasks/files/<taskId>/<filename>` (`FILES_DIR = "tasks/files"`).
- `coreUpdateTask` (core/tasks.ts `updateTask`) writes under a cross-process lock file `<taskLockPath>` (`openSync(lock,"wx")` spin-wait, 5s deadline, 10s stale reaping) — two racing writes are serialized, no corrupted JSON.

---

## 2. Scenario groups

### 2.1 Transport/session lifecycle (`mcp-transport.test.ts`)

Transport facts: `POST|GET|DELETE /api/mcp` on Express; `StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true })`; per-session `McpServer`; unknown session id on POST → **404 `{error:"Session not found"}`**; POST without `mcp-session-id` always creates a new session; DELETE without session id → 400; GET without session id → 400; unknown session id on GET → 404; CORS preflight exempted at the mount (OPTIONS → 204).

Each step: `POST <mcpUrl>` with JSON-RPC body, `Content-Type: application/json`. curl equivalent:

```bash
curl -s -D - http://127.0.0.1:<port>/api/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'
```

| # | Step | Payload | Expected |
|---|------|---------|----------|
| 1 | initialize [now] | body #1 above | 200; `mcp-session-id` header present (UUID); `body.result.protocolVersion === requested`; `body.result.serverInfo.name === "vibeflow"`; `serverInfo.version === "0.1.0"`; `body.result.capabilities.tools.listChanged` defined (tools capability advertised) |
| 2 | initialize with different requested protocol version [now] | same with `protocolVersion: "2024-11-05"` | 200; result.protocolVersion is the SDK-supported version (echo or downgrade) — assert 200 + defined protocolVersion, not exact value |
| 3 | notifications/initialized [now] | `{"jsonrpc":"2.0","method":"notifications/initialized"}` with session header | 202, empty body (enableJsonResponse) |
| 4 | tools/list [now] | `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}` with session header | 200; `body.result.tools` array of exactly 10 entries; each has `name` + `description` + `inputSchema` (type object) |
| 5 | tools/call on fresh session without notification/initialized [now] | initialize → tools/list **without** the notifications/initialized step | 200 ok (SDK does not hard-require the notification; assert either 200 or JSON-RPC error with code -32002 and NOT HTTP 500 — pin whichever after first run) |
| 6 | DELETE session [now] | `DELETE` with session header | 200 `{ok:true}`; then POST tools/list with same session → 404 `{"error":"Session not found"}` |
| 7 | DELETE without session id [now] | `DELETE` no header | 400 `{"error":"Session ID required for DELETE"}` — clean, not 500 |
| 8 | GET without session id [now] | `GET` no header | 400 `{"error":"Session ID required for GET"}` |
| 9 | GET unknown session id [now] | `GET` header `00000000-0000-4000-8000-000000000000` | 404 `{"error":"Session not found"}` |
| 10 | POST with deleted/never-existed session id [now] | tools/list with header `11111111-2222-4333-8444-555555555555` | 404 `{"error":"Session not found"}` — no 500 |
| 11 | POST without session header and non-initialize body [now] | tools/call body, no header | **not** 500: server creates a fresh session then `transport.handleRequest` rejects the non-initialize request — assert `status ∈ {400, 421}` or 200 with JSON-RPC error code -32600/-32002 (pin after first run; the invariant is "clean rejection, no 500") |
| 12 | concurrent sessions [now] | initialize 2 independent clients (A, B); A calls create_task; B calls list_tasks | both 200; `A.sessionId !== B.sessionId`; B sees the task A created (shared task store — expected); getSessionCount() === 2 while both alive [now, in-process only] |
| 13 | session id from ANOTHER server instance [now — must use spawn] | boot server S2 in a **separate process** (spawn helper, `serve --no-open`); take a live session id from the in-process server S1; POST tools/list to S2 with S1's id | 404 `{"error":"Session not found"}` |
| 14 | OPTIONS preflight [now] | `OPTIONS` | 204; `Access-Control-Allow-Origin` fixed to `http://localhost:3700` (not a reflection of `Origin` — credential-leak guard); `Access-Control-Allow-Headers` includes `mcp-session-id` and `Authorization` |
| 15 | GET SSE stream with live session [now] | `GET` with live session id | 200 with `Content-Type: text/event-stream` (or, if the SDK 405s GET when enableJsonResponse — assert "not 500, documented status"); destroy the connection immediately after asserting headers |

Pitfall documented: `sessions` Map is module-scope — within one fork, two `serve()` instances **share** session state, so scenario 13 must use the spawned separate-process server, and every in-process test must `stopMcpForTests()`.

Cleanup: per test `await env.cleanup()` (closes instance, rm temp dir, `stopMcpForTests()`); spawned server: `child.kill()` + rm temp HOME/project dirs.

### 2.2 Every tool happy path over HTTP (`mcp-tools.test.ts`)

Common contract per call: HTTP 200; `body.jsonrpc === "2.0"`; `body.result.isError === false` **or absent** [note: `formatResult` returns error envelopes as ok-shaped content without `isError: true` — see 2.3]; `body.result.content` = `[{type:"text", text:<JSON string>}]`; **`typeof body.result.content[0].text === "string"` and `JSON.parse` succeeds** (the contract bug class — `formatResult` does `JSON.stringify(result.data)` which yields `undefined` for `data === undefined`); `body.result.structuredContent` is currently **absent** [Phase 5 note: if manifest registration switches tools to `outputSchema`, flip to structuredContent assertion].

Seed: initialize + notifications/initialized once per test; seed tasks via `create_task` tool (not file writes) so every on-disk effect goes through the tools.

| # | Tool | Arguments (`arguments` field of tools/call) | Assertions |
|---|------|---------------------------------------------|------------|
| 1 | create_task | `{"title":"Fix CTA spacing","description":"Button overflows on mobile","priority":"High","tags":["ui","layout"],"url":"http://127.0.0.1:3700/index.html","selector":"[data-vibeflow-id=cta]"}` | parsed text: `{ok task}` with `id` (30-char hex `^[a-f0-9]{30}$`), `status:"todo"`, `type:"Task"`, `priority:"High"`, `created` ISO; on disk: exactly one `.vibeflow/tasks/**/<id>.json` whose JSON matches parsed text (title, description, tags, url, selector); `comments: []`, `files: []` |
| 2 | list_tasks | `{"limit":0}` | parsed text `{tasks:[...], total:N}` with N === created count; every seeded task present with `id`, `title`, `status` |
| 3 | list_tasks filtered | `{"status":"todo","type":"Task","limit":5,"fields":["id","title"],"user":"?","tag":["ui"]}` (one call per filter; omit `user` when no author set) | only matching tasks; `fields:["id","title"]` returns objects with ONLY those keys (field projection contract from operations.ts) |
| 4 | get_task | `{"id":"<prefix-of-id>"}` | parsed text task object with `id` (full), `title`, `description`; **prefix IDs resolve** (get/getTask uses findTaskFilePath prefix matching) |
| 5 | update_task | `{"id":"<id>","title":"New title","description":"New desc","branch":"fix/cta-spacing"}` | parsed text updated task; on disk file has `title:"New title"`, `description:"New desc"`, `branchName:"fix/cta-spacing"`, `updated` bumped; `comments` unchanged (comment key unused) |
| 6 | update_task + comment | `{"id":"<id>","status":"in-progress","comment":"started work"}` | parsed text status `"in-progress"`; on disk `comments` contains an embedded comment `[agent] "started work"` (coreUpdateTask + addComment(projectDir, id, "agent", text)); [Phase 3 note: `verified` reset to `false` on in-progress is CLI-only today — see gate matrix] |
| 7 | claim_next_task | seed 2 todo tasks (priorities High, Low) then `{"dryRun":false}` | parsed text claimed task with `status:"in-progress"` and id === the High-priority todo task; on disk: claimed task `status:"in-progress"`; the other untouched; author NOT set [now] — `createMcpServer` builds `ctx = { projectDir, mode }` with **no `userId`**, so `operations.claimNextTask` writes `author: undefined` — document + [Phase 2] TODO: assert `author === git user name` once MCP ctx wires getGitUser |
| 8 | claim_next_task dryRun | `{"dryRun":true}` on a todo task | parsed text `steps:["Dry run: task would be claimed"]` and task still `todo` on disk |
| 9 | add_comment | `{"id":"<id>","text":"Root cause: X","author":"user"}` | parsed text comment `{id, author:"user", text, createdAt}`; on disk task JSON has embedded comment; `get_task` shows it |
| 10 | attach_file | `{"id":"<id>","filename":"report.md","contentB64": base64("# Report\ncontent")}` | parsed text `{name:"report.md", size, url:"/api/tasks/<id>/files/report.md"}`; on disk `.vibeflow/tasks/files/<id>/report.md` with exact bytes; task JSON `files` ref `{name:"report.md", addedAt}`; size === buffer length |
| 11 | export_prompt single | `{"id":"<id>","format":"markdown"}` | parsed text is a **string** starting `[<status>] <title>` containing `id:`, `selector:`, `comments (N):` lines (renderTaskForAgent format) |
| 12 | export_prompt multi/all | `{"ids":["<a>","<b>"]}` and `{}` | parsed text joined by `\n\n`; all seeded tasks exported |
| 13 | verify_task — error envelope, no browser | `{"id":"<nonexistent>","timeoutMs":1000}` | HTTP 200; parsed text `{error:"E_NOT_FOUND", message:...}` envelope (verifyTask throws VerifyError before any Playwright import); assert no `verified` mutation on disk |
| 14 | verify_task — no baseline | `{"id":"<existing>","timeoutMs":1000}` | parsed text `{error:"E_NO_BASELINE"}` envelope; no browser launch (both paths fire before `loadPlaywright()`) — full visual verify requires browser ⇒ **skip happy path**, covered by `vitest.pw.config.ts` browser tests |
| 15 | push_tasks — empty board envelope | `{"keepLocalFiles":true}` with NO SaaS token (HOME-isolated in-process: set `process.env.HOME = tmpHome` at file top before dynamic import) | **envelope contract only**: `typeof body.result.content[0].text === "string"` and text parses as JSON — today `push()` returns `void` when the board is empty, so `result.data === undefined` and `JSON.stringify(undefined) === undefined` ⇒ text may be the literal string `"undefined"` or the property may be `undefined` — pin current behavior, then assert the fixed contract `JSON.parse succeeds` [now: document bug class + TODO flip] |
| 16 | push_tasks — with mock SaaS | seed token `tmpHome/.vibeflow/token`; seed `VIBEFLOW_API_URL=http://127.0.0.1:<mockPort>` (spawn loopback mock returning `{"imported":2,"skipped":0,"ids":[...],"workspaceId":"ws1","boardId":"ws1"}`); args `{"workspace":"ws1","keepLocalFiles":true}` | parsed text has `imported: 2`; no `login()`/browser (token exists ⇒ `push()` skips device flow — without a token `push()` triggers `login()` which `open()`s a browser and polls; **never** test push without token in-process against real API URL) |
| 17 | list_tasks after every mutation | `{"limit":0,"fields":["id","status"]}` | final statuses consistent with mutations (in-progress claimed, etc.) |

Cleanup: standard `env.cleanup()`; for 16: kill mock server, rm `tmpHome`.

### 2.3 Error paths (`mcp-errors.test.ts`)

Protocol-level errors come back HTTP 200 with JSON-RPC `error` (MCP SDK style), tool-level errors come back HTTP 200 with ok-shaped `content[0].text` JSON envelope `{error, message, suggestion}` (formatResult). Invariants asserted in every case: HTTP not 5xx; response body parses; server stays usable (next valid call succeeds).

| # | Case | Payload | Expected |
|---|------|---------|----------|
| 1 | unknown tool | tools/call `{"name":"nonexistent_tool","arguments":{}}` | 200; `body.error.code === -32601` (method/tool not found) |
| 2 | create_task missing title | `{"description":"no title"}` | 200; JSON-RPC error code `-32602` (invalid tool arguments — zod) |
| 3 | create_task bad status enum | `{"title":"x","status":"not-a-status"}` | 200; `-32602` |
| 4 | list_tasks bad limit | `{"limit":-1}` | 200; `-32602` (zod `.min(0)`) |
| 5 | get_task nonexistent id | `{"id":"ffffffffffffffffffffffffffff00"}` | 200; parsed text `{error:"TASK_NOT_FOUND", message:"Task not found: ...", suggestion:"Check the task ID and try again"}` |
| 6 | update_task nonexistent id | `{"id":"ffffffffffffffffffffffffffff00","title":"x"}` | 200; parsed text `{error:"TASK_NOT_FOUND"}`; on disk unchanged |
| 7 | attach_file path traversal | `{"id":"<id>","filename":"../escape.md","contentB64":"aGVsbG8="}` | 200; parsed text `{error:"ATTACH_FILE_ERROR"}` **or** content written under the stripped basename — pin behavior after first run; hard assert: **no file outside `.vibeflow/tasks/files/<id>/`** (scan `env.projectDir` recursively) |
| 8 | attach_file control chars / separators / null byte | filenames `..\\evil.md`, `sub/dir.md`, `"a\u0000b.md"`, `"a\u0001b.md"` | no escape from files dir; no control bytes in written filename |
| 9 | add_comment nonexistent id | `{"id":"ffffffffffffffffffffffffffff00","text":"x"}` | 200; parsed text `{error:"ADD_COMMENT_ERROR"}` (core addComment throws) |
| 10 | export_prompt nonexistent single id | `{"id":"ffffffffffffffffffffffffffff00"}` | 200; parsed text `{error:"TASK_NOT_FOUND"}` |
| 11 | claim_next_task empty board | `{"dryRun":false}` (no tasks) | 200; parsed text `{error:"NO_TASKS_AVAILABLE", message:"No tasks available to claim"}`; note [now] `body.result.isError` is absent/false — error-as-content contract; [Phase 5 flip note: manifest-based registration may set `isError: true` — pin and flip] |
| 12 | verify_task bad url | `{"id":"<id>","url":"nota-url"}` | 200; `-32602` (zod `.url()`) |
| 13 | server survives error storm | run cases 1–12 on one session then a valid list_tasks | 200 ok — no session corruption |
| 14 | malformed JSON body [now] | POST with `body: "{"` | not 500: transport responds 400 (`parse error`) — assert `status === 400` |
| 15 | missing Accept header [now] | POST initialize with only `Content-Type` | not 500 — SDK requires Accept; expect 400/406; pin after first run |

### 2.4 update_task gate matrix (`mcp-errors.test.ts` describe "update_task gates") — [Phase 3-aware]

Read first, decision documented: today `operations.updateTask` (the MCP wrapper) has **NO** review gate and **no verified reset** — the gates live only in the CLI (`src/index.ts`: `--set-status review` without `--comment` → error + `ExitCode.USAGE`; `--set-status in-progress` → `updates.verified = false`; `requireVerifyBeforeReview` setting → verify-before-review block). Phase 3 will port these to the MCP `update_task` (`REVIEW_COMMENT_REQUIRED`, etc.).

Strategy: implement NOW with current behavior + TODO flip markers in one helper:

```ts
// [Phase 3] Gate assertions — flip to the gated expectations when Phase 3 lands.
// Feature-detect: a Phase-3 update_task will reject review+no-comment with an
// REVIEW_COMMENT_REQUIRED-style envelope. Until then the call succeeds.
const GATED = false; // flip to true in Phase 3
```

| # | Call | [now] Expected | [Phase 3] Expected (flip) |
|---|------|----------------|---------------------------|
| 1 | `{"id":"<id>","status":"review"}` (no comment) | 200; parsed text ok; on disk status review | 200; parsed text `{error:"REVIEW_COMMENT_REQUIRED"}`; on disk status unchanged |
| 2 | `{"id":"<id>","status":"review","comment":"Report: what changed and why"}` | 200 ok; on disk review + embedded agent comment | same (stable across the flip) |
| 3 | `{"id":"<id>","status":"review","comment":"x","skipVerify":true}` | ok (skipVerify accepted today) | ok — gate skipped via skipVerify |
| 4 | `{"id":"<id>","status":"in-progress"}` on a `verified: true` task (seed task file with `verified: true` via create_task + direct file write for seeding only) | [now] parsed text ok; `verified` stays true (MCP wrapper has no reset — CLI-only) | flip: `verified: false` on disk + TODO marker |
| 5 | done-warning parity | `{"id":"<id>","status":"done"}` | [now] ok (MCP has no agent done warning); CLI prints warning only — document asymmetry; no flip |

For each flip: `if (!GATED) { expect(parsed.error).toBeUndefined(); } else { expect(parsed.error).toBe("REVIEW_COMMENT_REQUIRED"); }` — one boolean, documented.

### 2.5 claim atomicity e2e (`mcp-claim-race.test.ts`) — [Phase 2-aware]

Facts: `tasks --next --json` (spawned CLI) prints `{success:true, task:{...claimed, filePath}, next_actions:[...]}`; empty board prints plain text "No todo tasks found. Nothing to work on." (NOT JSON, exit 0). MCP `claim_next_task` does find-then-update: `coreUpdateTask` is serialized by the cross-process lock (core/tasks.ts), but the **find is not atomic** — two racers can both select `tasks[0]` and both claim it. Phase 2 will fix.

Setup: tmp project via `ensureTaskDirs(tmp)` (same fast setup as init.test.ts); seed 2 todo tasks directly (flat layout `<id>.json`, mirroring init.test.ts) with distinct priorities; HOME-isolated env.

| # | Step | Expected [now] | [Phase 2] flip |
|---|------|----------------|----------------|
| 1 | spawn two `tasks <tmp> --next --json` concurrently (Promise.all, execFile) | both exit 0 within testTimeout; parse both stdout as JSON; `r1.task.id` and `r2.task.id` — [now] assert both parses succeed and task files are consistent JSON (lock holds, no corruption); document: racers may claim the SAME task; TODO flip: `r1.task.id !== r2.task.id` and exactly one task per racer |
| 2 | spawn two MCP claim_next_task over one in-process server (Promise.all on callTool) | both 200; both parsed-text JSON envelopes; statuses on disk `in-progress`; [now] same-task double-claim allowed; TODO flip: different ids |
| 3 | spawn `tasks <tmp> --next --json` (single) on empty board | stdout is NOT JSON (plain text) — document; parse guard `if (stdout.trim().startsWith("{"))` |
| 4 | MCP claim author | seed git user (`git init` + `git config user.name "E2E User"` in tmp — init.test.ts style git setup); claim via MCP | [now] parsed text has NO `author` (ctx.userId missing in createMcpServer) — document; [Phase 2] TODO flip: `author === "E2E User"` |

Determinism: racers get disjoint temp projects per test; HOME override; telemetry off.

### 2.6 Auth (`mcp-auth.test.ts`)

Facts (`src/mcp/auth.ts`): per-request `readAuthToken()` reads `~/.vibeflow/auth.json` `{"token": <string>}` — read **dynamically each request** (join(homedir(), ...)), so HOME override applies per request without import-order tricks; no token configured ⇒ **loopback-only** (req.ip ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}); token configured ⇒ `Authorization: Bearer` required; missing header ⇒ 401; wrong token ⇒ **403**; right token ⇒ next(); compare is SHA-256 + `timingSafeEqual`. `req.ip` derivation: Express with **no `trust proxy`** set anywhere in server.ts ⇒ `req.ip` = socket remote address; **X-Forwarded-For forging is ignored** — the LAN-connect test must bind `0.0.0.0` and connect via the LAN IPv4, same-machine.

Boot: **spawned** server (`spawnApiServer`, `serve --no-open`, `HOME = tmpHome`, random port) so auth state lives in `tmpHome/.vibeflow/`.

| # | Step | Setup | Expected |
|---|------|-------|----------|
| 1 | loopback without token | no auth.json | initialize → 200, session id header |
| 2 | full handshake + tool call without token | no auth.json | tools/list → 200 (loopback is enough end-to-end) |
| 3 | non-loopback without token [now] | bind `0.0.0.0` (`serve --host 0.0.0.0`); connect `http://<LAN-IPv4>:<port>/api/mcp` (resolve via `networkInterfaces()` — first non-internal IPv4, mirroring server.ts getLanIp) | 401 `{"error":"Unauthorized","message":"MCP requires authentication for non-loopback connections"}`; **skip (test.skip when no LAN IPv4)** — mark the skip reason in the report |
| 4 | X-Forwarded-For does NOT spoof loopback [now] | bind `0.0.0.0`; connect via LAN IP with header `X-Forwarded-For: 127.0.0.1` | still 401 (no `trust proxy`) — pin; if Express default changes this flips |
| 5 | token configured, no Bearer | write `tmpHome/.vibeflow/auth.json {"token":"s3cr3t-e2e"}` (before boot — readToken is per request, either order works); loopback connect | 401 `{"error":"Unauthorized","message":"Missing or invalid Authorization header"}` |
| 6 | token configured, wrong Bearer | same; header `Bearer wrong-value` | **403** `{"error":"Forbidden","message":"Invalid authentication token"}` |
| 7 | token configured, valid Bearer | same; header `Bearer s3cr3t-e2e` | 200; handshake + tools/list succeed |
| 8 | token with control/diff length (compare robustness) [optional, skip] | `{"token":"a"}`; Bearer `ab` | 403 — timing measured only if CI allows; default **skip** |

### 2.7 Session reaping (`mcp-transport.test.ts` describe "reaping") — practical approach after reading mcp/http.ts

Read-first result: `SESSION_TTL = 30 * 60 * 1000` (module const), `reapStaleSessions` + `startSessionReaper` + `refreshSession` are **module-private**; reaper sweeps every 5 min and `unref()`s. Exports: `disposeMcp()`, `getSessionCount()`, `clearSessions()`, `stopMcpForTests()`. `lastSeen` cannot be manipulated from outside; cannot fast-forward time.

| # | Step | Approach | Expected |
|---|------|----------|----------|
| 1 | session count bookkeeping [now] | initialize 2 clients → `getSessionCount() === 2` (in-process fork only — module state); DELETE one → `getSessionCount() === 1` | count exact |
| 2 | reaper interval single-instance [now, unit-side] | call `mountMcp` twice (2 serve instances in one fork) → still exactly one reaper interval (guarded by `if (reaper) return`) | no interval leak — assert indirectly: disposeMcp() clears all, subsequent mount works |
| 3 | stale-session reap [needs 1-line export — prerequisite] | `reapStaleSessions` must become exported (e.g. `export function reapMcpSessionsForTests(): void { reapStaleSessions(); }`) to test without waiting 30 min: initialize; age the session by rewrite... **cannot rewrite `lastSeen` (module-private)** ⇒ recommended follow-up: export a test hook `export function ageMcpSessionsForTests(ms: number): void` or make `SESSION_TTL`/`lastSeen` readable | after aging > TTL + call `reapMcpSessionsForTests()` → `getSessionCount() === 0` and POST with the aged id → 404 |
| 4 | disposeMcp lifecycle [now] | initialize 1; `disposeMcp()`; POST with that id | 404; count 0; `stopMcpForTests()` equivalent |

Practical reaping test TODAY without refactor: none that is deterministic — scenario 3 is a documented follow-up task (`[prereq] export reapStaleSessions test hook` — one-line, Phase 0.1). Everything else (TTL math, refresh-on-use) is private.

### 2.8 MCP-from-manifest parity (`mcp-parity.test.ts`) — [Phase 5-aware]

Facts: `src/mcp/server.ts` registers 10 tools with **hand-copied** descriptions/schemas; `src/mcp/manifest.ts` is the intended single source of truth (`input: z.ZodType`, `description`, `cliRef`, `annotations`). Phase 5 will register tools FROM the manifest so tools/list must match it exactly. Existing drift tests (`tests/unit/mcp/drift.test.ts`) cover manifest shape statically — this suite covers **parity via tools/list over HTTP**.

| # | Step | Payload/expectation |
|---|------|---------------------|
| 1 | names parity | initialize; tools/list; `sort(tools.map(t=>t.name))` === `sort(manifest.map(m=>m.name))` — exactly 10, no extras [now both hand-copied and manifest agree; the test starts earning its keep the moment Phase 5 lands or a new tool is added to only one side] |
| 2 | descriptions parity | for each name: `tools/list.description === manifest entry.description` (server.ts copies these verbatim today) |
| 3 | light schema check via invalid-args rejection [now] | for each tool: call with an intentionally invalid documented field (e.g. `create_task {title:123}` as wrong type; `update_task {status:"bogus"}`; `export_prompt {format:"html"}`; `list_tasks {limit:-1}`) — expect `-32602`-style rejection, i.e. the HTTP schema accepts-and-enforces the manifest-documented fields; a tool that ACCEPTS the invalid value ⇒ schema drift bug |
| 4 | inputSchema key parity (strict version, flip in Phase 5) | compare `inputSchema.properties` keys per tool against the manifest zod shape — implement as a **soft parity table**: pin today's keys (hand-copied server.ts) with the manifest-derived expectation as a comment; [Phase 5 flip] derive both from the manifest and assert strict equality |
| 5 | annotations [Phase 5 flip note] | tools/list currently returns NO `annotations` field (hand-registered via server.tool without annotations) — assert `t.annotations === undefined` [now]; Phase 5 flip: `t.annotations` equals `manifest.annotations` per tool |

### 2.9 CLI hang regression (`mcp-hang.test.ts`) — plan Phase 1 e2e

| # | Step | Expected |
|---|------|----------|
| 1 | spawn `tasks <tmp> --add --title "hang probe" --json` with NO server running (HOME-isolated, telemetry off), measure elapsed | exit 0; elapsed **< 3000 ms**; stdout parses as `{success:true, task:{...}}`; task exists on disk |
| 2 | spawn `tasks <tmp> --next --json` empty board, no server | exit 0; elapsed < 3000 ms; non-JSON stdout |
| 3 | spawn `tasks <tmp> --json` list, no server | exit 0; elapsed < 3000 ms; stdout parses as `[]` |

(If the plan Phase 1 already adds `mcp-hang.test.ts`/equivalent to tests/e2e, reference it here instead of duplicating — worker prompt: grep tests/e2e for the file before implementing.)

---

## 3. Per-scenario payloads, assertions, cleanup — quick reference

JSON-RPC bodies (all POSTs unless noted):

```json
// initialize (no mcp-session-id header)
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-e2e-client","version":"0.0.0"}}}

// notification (session header, expect 202)
{"jsonrpc":"2.0","method":"notifications/initialized"}

// tools/list
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}

// tools/call — one body per tool (realistic args):
create_task    {"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"create_task","arguments":{"title":"Fix CTA spacing","description":"Button overflows on mobile","priority":"High","tags":["ui"],"url":"http://127.0.0.1:3700/index.html","selector":"[data-vibeflow-id=cta]"}}}
get_task       {"name":"get_task","arguments":{"id":"<first-8-of-id>"}}
list_tasks     {"name":"list_tasks","arguments":{"limit":0}}
update_task    {"name":"update_task","arguments":{"id":"<id>","status":"in-progress","comment":"started work"}}
claim_next     {"name":"claim_next_task","arguments":{"dryRun":false}}
add_comment    {"name":"add_comment","arguments":{"id":"<id>","text":"Root cause: X","author":"user"}}
attach_file    {"name":"attach_file","arguments":{"id":"<id>","filename":"report.md","contentB64":"IyBSZXBvcnQ="}}
export_prompt  {"name":"export_prompt","arguments":{"id":"<id>","format":"markdown"}}
verify_task    {"name":"verify_task","arguments":{"id":"<id>","timeoutMs":1000}}
push_tasks     {"name":"push_tasks","arguments":{"workspace":"ws1","keepLocalFiles":true,"dryRun":false}}
```

Universal response assertions (helper `assertJsonTextContent`):

```ts
expect(res.status).toBe(200);
const body = await res.json();
expect(body.jsonrpc).toBe("2.0");
expect(body.id).toBe(10);
// happy path: body.error undefined; body.result.content[0].type === "text";
// typeof body.result.content[0].text === "string"  ← THE contract (verify_task bug class);
// JSON.parse(text) succeeds; body.result.isError falsy or absent;
// body.result.structuredContent absent [Phase 5 flip: present].
```

Cleanup matrix: in-process → `await instance.close(); rmSync(projectDir, {recursive,force}); rmSync(tmpHome, {recursive,force}); stopMcpForTests(); restore process.env.HOME`. Spawned → `child.kill(); await exit event; rm dirs`. Mock SaaS → `server.close()`. Never leave intervals: `stopMcpForTests()` unref'd reaper won't block exit but module state must not leak across forks' tests.

---

## 4. Worker prompt (copy-pasteable)

```text
TASK: Implement the MCP e2e test suite for the vibeflow CLI MCP server. Read /tmp/mcp-e2e-test-plan.md FIRST — it is the authoritative spec (file layout, helper design, scenario catalog with exact JSON-RPC payloads, expectations, [Phase N] flip markers, and cleanup rules). Do NOT modify any file under packages/cli/src/ — tests only.

Repo: /home/zorcec/workspace/vibeflow-workspace/vibeflow — all work in packages/cli/. The local dev build is the CLI binary: build once first (`npm run build` in packages/cli) — tests/e2e spawn `node dist/index.js` (same pattern as tests/e2e/init.test.ts).

Create exactly these files in packages/cli/tests/e2e/ (naming matches the e2e include pattern tests/e2e/**/*.test.ts):
  mcp-helpers.ts          — helpers per spec §1.1: bootMcpServer() (in-process `serve(undefined, {port: getFreePort(), open:false, projectDir: tmpDir, _testToken: null, _testWorkspace: null})` — the exact API-only boot pattern of the "API-only mode" describe in tests/e2e/serve.test.ts), getFreePort() via node:net listen(0), McpClient (fetch-based initialize → mcp-session-id header → notifications/initialized (expect 202) → tools/list/call wrapper), assertJsonTextContent() (HTTP 200, content[0].text is a string that parses as JSON — the TextContent contract), isolatedEnv()/runCli()/spawnApiServer() (spawn `node dist/index.js serve --no-open -p <free>` with env HOME=tmpHome + VIBEFLOW_TELEMETRY=0), and per-test cleanup that closes the instance, rmSync's temp dirs, and calls stopMcpForTests() (exported from src/mcp/http.ts).
  mcp-transport.test.ts   — scenario group 2.1 (initialize/protocolVersion/serverInfo/session header; notifications 202; tools/list 10 tools; DELETE → 200 {ok:true}; reuse of deleted session → 404 {"error":"Session not found"}; POST without session id never 500; GET/DELETE without session id → 400; unknown session id → 404; 2 concurrent clients isolated; OPTIONS → 204 with fixed Access-Control-Allow-Origin http://localhost:3700; session id from a spawned second server instance → 404; session-count bookkeeping via getSessionCount()).
  mcp-tools.test.ts       — scenario group 2.2: all 10 tools happy path over HTTP with the exact payloads from the spec; per tool assert the parsed text content AND the on-disk effect in the temp project (.vibeflow/tasks/<date|flat>/<id>.json, .vibeflow/tasks/files/<id>/<filename>); include verify_task E_NOT_FOUND/E_NO_BASELINE envelopes (no browser) and push_tasks envelope-only test with HOME-isolated token + loopback mock SaaS per spec 2.2 #15/#16; never test push_tasks without a token in-process (device login flow opens a browser).
  mcp-errors.test.ts      — scenario group 2.3 error paths (unknown tool -32601; zod invalid args -32602; TASK_NOT_FOUND/ADD_COMMENT_ERROR/NO_TASKS_AVAILABLE envelopes as content-JSON; attach_file traversal/control-char filenames never escape .vibeflow/tasks/files/<id>/ — recursive scan of the temp project; malformed JSON body → 400 not 500) AND the update_task gate matrix from 2.4 with the `const GATED = false;` [Phase 3] flip helper exactly as specified.
  mcp-auth.test.ts        — scenario group 2.6 with a HOME-isolated spawned server; write tmpHome/.vibeflow/auth.json for the token-configured cases (no-Bearer → 401, wrong → 403, valid → 200); loopback-no-token → 200; non-loopback via 0.0.0.0 + LAN IPv4 with test.skip when the machine has no LAN IPv4; assert X-Forwarded-For is ignored (no trust proxy). Never boot auth tests in-process without HOME isolation — the real ~/.vibeflow/auth.json would be read.
  mcp-claim-race.test.ts  — scenario group 2.5: two spawned `tasks <tmp> --next --json` racers on one HOME-isolated temp project (both parse as JSON {success:true,task:{...}}); document current same-task double-claim with the [Phase 2] TODO flip (assert different ids once claim atomicity lands); single --next on empty board prints non-JSON; MCP claim author [now] absent — [Phase 2] flip to git user name.
  mcp-parity.test.ts      — scenario group 2.8: tools/list names === manifest names (import { manifest } from ../../src/mcp/manifest.js), descriptions equal, light schema check per tool via an invalid documented field expecting -32602, soft parity for inputSchema keys and `annotations === undefined` with [Phase 5] flip notes.
  mcp-hang.test.ts        — scenario group 2.9: spawned `tasks <tmp> --add --title "hang probe" --json` with no server exits <3s and parses {success:true,...}; --next empty board <3s; --json list <3s. Grep tests/e2e first — if the plan Phase 1 already added this file, extend rather than duplicate.

Rules:
- Reuse existing patterns only: in-process serve() boot exactly like tests/e2e/serve.test.ts API-only describe; spawned CLI exactly like tests/e2e/init.test.ts (`node ${join(process.cwd(),"dist","index.js")} ...`); temp projects via mkdtempSync; HOME override is an established pattern (see the comment at the top of src/telemetry.ts).
- Deterministic: random ports only (never the fixed 3750+ ports serve.test.ts uses); no network beyond loopback (VIBEFLOW_TELEMETRY=0, mock SaaS on 127.0.0.1, prefer `serve` over `kanban` for spawned boots — kanban runs checkForUpdates); never assume real ~/.vibeflow state — always HOME-isolate or pass the _testToken/_testWorkspace:null boot hooks; no browser (verify_task tested via error envelopes only).
- Mark every assertion that depends on future phases exactly as in the spec: `const GATED = false;` + `// [Phase 3] flip` for gates, `// [Phase 2] flip` for claim atomicity/author, `// [Phase 5] flip` for structuredContent/annotations parity, and the `[prereq] export reapMcpSessionsForTests test hook` note for reaping (do NOT implement the reaping aging test — only the getSessionCount/DELETE/disposeMcp bookkeeping).
- Every test file: beforeEach boots, afterEach cleans up (close + rmSync + stopMcpForTests). No cross-test leakage of the module-scope MCP sessions map.
Run: `cd packages/cli && npm run build && npx vitest run --config vitest.e2e.config.ts tests/e2e/mcp-*.test.ts` — iterate until all green, then run the full e2e suite (`npm run test:e2e`) and the unit suite (`npm test`) and fix any regression your new files caused (e.g. port collisions, shared module state). Report: files created, scenario counts, any pinned-after-first-run expectations (spec items marked "pin after first run") with the actual observed behavior.
```

---

## 5. Run strategy

- **Configs.** All new files are `tests/e2e/mcp-*.test.ts` → run with the e2e config only: `npx vitest run --config vitest.e2e.config.ts tests/e2e/mcp-*.test.ts` (unit config include `tests/unit/**/*.test.ts` won't pick them up; e2e include `tests/e2e/**/*.test.ts` won't pick unit). `vitest.e2e.config.ts`: testTimeout 30s, hookTimeout 15s, `pool: "forks"` (min 4 / max 8) — each fork is a separate module registry, so the module-scope sessions map is per-fork; helpers must `stopMcpForTests()` anyway.
- **Single test file iteration:** `npx vitest run --config vitest.e2e.config.ts tests/e2e/mcp-tools.test.ts`.
- **Ports.** `getFreePort()` (node:net listen(0) → close → use). Never reuse serve.test.ts's fixed 3750–3757/3780–3785/9720–9726 ranges: the forks run in parallel and a dev server may hold 3700. Boot failure on EADDRINUSE → helper retries once with a fresh port.
- **No collision with running instances.** Existing serve tests + new tests may momentarily race for a freed port; the port is closed before the serve boot opens it (tiny TOCTOU — accepted, retry covers it).
- **Telemetry off everywhere.** Spawned processes: `VIBEFLOW_TELEMETRY=0` in env (isTelemetryEnabled short-circuit). In-process forks: telemetry reads `~/.vibeflow/config.json` from HOME — with HOME override it starts empty; PostHog client is only constructed on `capture()` of server commands — none of the test paths call `telemetry.capture` with enabled telemetry. Set `process.env.VIBEFLOW_TELEMETRY = "0"` at the top of mcp-helpers.ts for belt-and-braces.
- **HOME isolation.** Spawned: `env.HOME = tmpHome`. In-process fork: at file top, BEFORE dynamic import of src modules, `process.env.HOME = mkdtempSync(...)` (top-level await; ESM imports of src modules must be dynamic — see telemetry.ts "override HOME before importing this module" comment). Loopback-only boot needs no token file; MCP bearer token is read per request (dynamic homedir) — auth tests can flip HOME mid-test and restore in afterEach.
- **Offline determinism.** In-process boot always passes `_testToken: null, _testWorkspace: null` so the server can never silently boot SaaS mode because the dev machine has a real token (which would 503 the local API and NOT mount MCP at all).
- **tmp project isolation.** Every scenario: `mkdtempSync(join(tmpdir(), "mcp-e2e-"))` project + separate HOME tmpdir when auth/token state matters; rmSync in afterEach; racers in the claim test share exactly ONE project (that's the point) but each test gets its own.
- **Browser-free.** verify_task happy path excluded (E_NOT_FOUND/E_NO_BASELINE envelopes only — both fire before `loadPlaywright()`); push_tasks never exercised without token (device login `open()`s a browser); spawn boots use `serve --no-open`; `kanban` avoided (checkForUpdates + browser hint).
- **CI order.** `npm run build` → `npm test` (unit) → `npm run test:e2e` (all e2e) — new suite rides in the default e2e run; keep per-file runtime < ~5s by avoiding real SSE streams (destroy GET connections immediately) and real time-based reaping (untestable — documented prerequisite hook).

---

## 6. Discovered caveats the worker must know (read-first results)

1. **MCP mounts ONLY in API-only mode.** `serveApiOnly()` offline branch calls `mountMcp(...)`; the `serve <target>` HTML path does not. Never boot MCP tests with a positional HTML target.
2. **`_testToken: null` / `_testWorkspace: null` are load-bearing** — without them the server reads the real `~/.vibeflow/token` at boot and flips to SaaS mode (local API 503, MCP not mounted) on any machine with a logged-in token.
3. **push_tasks without a token triggers the interactive device login** (`login()` → device-init fetch → `open(verificationUrl)` browser → poll loop) from inside an MCP tool call. Never in-process-test that path against real hosts. Also: `push()` returning void makes `formatResult` emit `text: JSON.stringify(undefined) === undefined` — TextContent contract bug class, envelope test in 2.2 #15.
4. **MCP ctx has no `userId`** (`createMcpServer`: `ctx = { projectDir, mode }`) ⇒ `claim_next_task` writes `author: undefined` — the "claim sets author = git user name" expectation is NOT current behavior; [Phase 2] flip.
5. **update_task gates are CLI-only today** (review-without-comment → USAGE exit; verified-reset on in-progress; verify-before-review setting). MCP wrapper has none. Gate matrix = [Phase 3] with the `GATED` flip.
6. **coreUpdateTask already has a cross-process write lock** (spin-wait `wx` lock, 5s deadline, stale reap) — racer JSON corruption is prevented, but find-then-claim selection is still racy (both racers can pick tasks[0]) — [Phase 2] atomicity flip.
7. **Error envelopes are ok-shaped** (`isError` absent): `formatResult` returns `{error,...}` as content JSON without `isError: true`. Pin now, revisit at Phase 5 manifest registration.
8. **`sessions` Map is module-scope per fork** — concurrent `serve()` instances in one process share session state; cross-instance rejection must use a spawned second process; reaping `lastSeen`/TTL is module-private and untestable without the 1-line test-hook export (`[prereq]`).
9. **No `trust proxy` anywhere** ⇒ `X-Forwarded-For` is ignored; non-loopback auth e2e requires `--host 0.0.0.0` + LAN-IPv4 connect (skip when the box has no LAN IP).
10. **`mcp-session-id` is `crypto.randomUUID()`**; deleted-session POST → 404 `{"error":"Session not found"}`; DELETE/GET without id → 400 with matching messages; CORS origin pinned to `http://localhost:3700` (never reflects request Origin).
