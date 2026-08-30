# Visual Verification Loop — Implementation Plans

> Plans for 5 improvements to the Visual Verification Loop feature.
> Created: 2026-08-29 | Branch: `feature/visual-verification-loop`

---

## Improvement 1: verify.ts Unit Tests

### Current State

`commands/verify.ts` (588 lines) has no dedicated unit test file. The core logic it depends on (diff, auth, gating) is well-tested, but the `verifyTask` function itself — error paths, result shape, Playwright integration — is untested.

### Plan

#### 1.1 Extract `VerifyError` to a shared location

- Move `VerifyError` class to `core/verify-error.ts` so tests can import and check `err.code`
- Keep `verify.ts` importing from the shared location

#### 1.2 Create `tests/unit/commands/verify.test.ts`

- Mock Playwright via `vi.mock("playwright")` — return a mock browser/context/page
- Mock `findTaskFilePath`, `readTaskFile`, `existsSync`, `readFileSync` for error paths
- Mock `saveFile`, `addComment` for evidence storage and system comment

#### 1.3 Test error codes (§9.4)

Each error code gets its own test:

| Error Code | Test Setup |
| --- | --- |
| `E_NOT_FOUND` | `findTaskFilePath` returns null |
| `E_NO_BASELINE` | Task exists but baseline.json missing |
| `E_BASELINE_CORRUPT` | Baseline.json contains invalid JSON |
| `E_AUTH_EXPIRED` | Auth state file exists, decryptAuthState returns null |
| `E_AUTH_CORRUPT` | Auth state file exists, decryptAuthState throws |
| `E_NO_URL` | Task has no url, no --url override |
| `E_NO_SELECTOR` | Task selector is "/" (root) |
| `E_PLAYWRIGHT_MISSING` | `import("playwright")` throws |
| `E_PLAYWRIGHT_CRASH` | `browser.launch()` throws with generic error |
| `E_APP_NOT_RUNNING` | `page.goto()` throws with ECONNREFUSED |
| `E_NAVIGATION_FAILED` | `page.goto()` throws with generic error |

#### 1.4 Test happy paths

- **Verify with auth**: Task + baseline + auth state → successful verification
- **Verify without auth**: Task + baseline, no auth file → unauthenticated verification
- **Verify with --url override**: Task URL differs from --url
- **Selector not found**: Element removed after baseline → `selectorResolves: false`
- **Multiple elements match**: Ambiguous selector → verdict mentions element count

#### 1.5 Test result shape (§9.3)

- Verify `taskId`, `ok`, `taskDescription`, `baseline`, `after`, `diff`, `evidenceFiles`, `verdict` are present
- Verify `ok = true` when selector resolves + no new console errors
- Verify `ok = false` when selector doesn't resolve or new errors exist

#### 1.6 Test system comment

- Verify `addComment` is called with `"agent"` author, `"system"` type
- Verify comment text includes "✅ passed" or "⚠️ issues detected"

#### 1.7 Test `runVerify` (CLI entry point)

- Test JSON output mode (`--json`)
- Test error output mode (VerifyError → stderr)
- Test exit code setting on error

### Files to Create/Modify

- **Create**: `packages/cli/src/core/verify-error.ts`
- **Create**: `packages/cli/tests/unit/commands/verify.test.ts`
- **Modify**: `packages/cli/src/commands/verify.ts` — import VerifyError from shared location

### Risks

- Mocking Playwright requires careful setup — mock `chromium.launch()`, `browser.newContext()`, `page.goto()`, `page.waitForSelector()`, `page.locator()`, `page.evaluate()`
- Mocking file system calls (`existsSync`, `readFileSync`) requires `vi.mock("node:fs")`

### Estimated Effort

3-4 hours (test file ~400-500 lines)

---

## Improvement 2: gating.ts Mutation Score Improvement

### Current State

- Mutation score: 74.55% (14 survived)
- All 7 tests pass and kill most mutants
- Survived mutants are likely in:
  - String literal changes in error messages (cosmetic)
  - Boolean literal changes in edge cases
  - Conditional expression changes in boundary conditions

### Plan

#### 2.1 Run Stryker with detailed mutant output

- Run `npx stryker run --mutate "src/core/gating.ts" --reporters clear-text`
- Capture each survived mutant with its location and mutator type

#### 2.2 Categorize survived mutants

For each survived mutant, apply the decision framework:

| Category | Action | Example |
| --- | --- | --- |
| **Semantically equivalent** | Add `// Stryker disable once` comment | Error message string changes |
| **Logic gap** | Add edge case to logic | Missing null check |
| **Test gap** | Add test assertion | Test doesn't assert return value |

#### 2.3 Likely improvements

Based on the code structure, the survived mutants are probably:

1. **String literal in error messages** (e.g., `"Task not found: ${taskId}"`) → IGNORE with stryker disable
2. **`VERIFY_EVIDENCE_PREFIX` and `VERIFY_EVIDENCE_SUFFIX` constants** → These are structural, not semantic. IGNORE.
3. **`readdirSync` error handling** (`catch` block) → Add test that mocks `readdirSync` to throw
4. **`existsSync` check for filesDir** → Add test where `existsSync` returns false but task has files array
5. **`task.files.some()` predicate** → Test with empty files array, test with files that partially match

#### 2.4 Add targeted tests

- Test: `readdirSync` throws → should return `allowed: false`
- Test: `existsSync(filesDir)` returns false → skip disk check, return based on task files
- Test: Task has `files: undefined` (not empty array) → skip files array check, go to disk check
- Test: Task has `files: []` (empty array) → skip files array check, go to disk check
- Test: File named `verify-after.json` in files array → allowed
- Test: File named `verify.txt` (wrong extension) → not allowed
- Test: File named `verify-.json` (empty name between prefix/suffix) → allowed (matches pattern)

#### 2.5 Add Stryker disable comments for equivalent mutants

Add to `gating.ts`:

```typescript
// Stryker disable next-line StringLiteral: error message is for human readability only
`Task not found: ${taskId}`
```

### Files to Create/Modify

- **Modify**: `packages/cli/tests/unit/gating.test.ts` — add 3-5 targeted tests
- **Modify**: `packages/cli/src/core/gating.ts` — add Stryker disable comments for equivalent mutants

### Risks

- Some survived mutants may be in imported modules (`listTasks`) — not in gating logic itself
- Need to verify the exact survived mutants before deciding on actions

### Estimated Effort

1-2 hours

---

## Improvement 3: Overlay Types Dedup

### Current State

Types are duplicated in two locations:

| Type | Location 1 | Location 2 |
| --- | --- | --- |
| `PositionContext` | `core/diff.ts` | `overlay-browser/core/types.ts` |
| `DomSnapshot` | `core/diff.ts` | `overlay-browser/core/types.ts` |
| `AuthState` | `core/auth.ts` | `overlay-browser/core/types.ts` |
| `EncryptedAuthState` | `core/auth.ts` | `overlay-browser/core/types.ts` |

The overlay types are used by browser-side code (compiled to IIFE bundle), while the CLI types are used by Node.js code.

### Plan

#### 3.1 Create `core/verification-types.ts`

- Single source of truth for all verification-related types
- Export: `PositionContext`, `DomSnapshot`, `AuthState`, `EncryptedAuthState`, `DiffResult`
- No runtime dependencies (pure type definitions)

#### 3.2 Update imports in CLI code

- `core/diff.ts` → import from `core/verification-types.ts`
- `core/auth.ts` → import from `core/verification-types.ts`
- `commands/verify.ts` → import from `core/verification-types.ts`

#### 3.3 Update imports in overlay code

- `overlay-browser/core/types.ts` → import from `core/verification-types.ts`
- `overlay-browser/core/auth.ts` → import from `core/verification-types.ts`
- `overlay-browser/core/baseline.ts` → import from `core/verification-types.ts`
- `overlay-browser/core/verify-mode.ts` → import from `core/verification-types.ts`

#### 3.4 Keep `overlay-browser/core/types.ts` for non-verification types

- `Task`, `TaskGroup`, `ProtoConfig` stay in `overlay-browser/core/types.ts`
- These are overlay-specific and not shared with CLI

#### 3.5 Verify bundle still works

- Run `pnpm --filter @vibeflow-tools/cli run build` to ensure the overlay bundle compiles
- The overlay is compiled to IIFE — verify the import chain works

### Files to Create/Modify

- **Create**: `packages/cli/src/core/verification-types.ts`
- **Modify**: `packages/cli/src/core/diff.ts` — import types from verification-types
- **Modify**: `packages/cli/src/core/auth.ts` — import types from verification-types
- **Modify**: `packages/cli/src/commands/verify.ts` — import types from verification-types
- **Modify**: `packages/cli/src/client/overlay-browser/core/types.ts` — remove duplicated types, import from verification-types
- **Modify**: `packages/cli/src/client/overlay-browser/core/auth.ts` — import types from verification-types
- **Modify**: `packages/cli/src/client/overlay-browser/core/baseline.ts` — import types from verification-types
- **Modify**: `packages/cli/src/client/overlay-browser/core/verify-mode.ts` — import types from verification-types

### Risks

- Import paths change — need to verify the overlay bundle compilation works
- The overlay is compiled with tsup to IIFE — the import resolution must work in that context
- If `core/verification-types.ts` imports anything from Node.js, it will break the overlay bundle

### Estimated Effort

1-2 hours

---

## Improvement 4: Integration Tests

### Current State

No integration tests exist for the full verify flow. Unit tests mock Playwright and file system. E2e tests use the CLI binary but don't test the verify command specifically.

### Plan

#### 4.1 Create `tests/integration/verify.test.ts`

#### 4.2 Set up test infrastructure

- Use `vitest` (already configured)
- Create a temporary project directory with `.vibeflow/tasks/` structure
- Create a simple HTML test page served by `node:http` (or use Playwright's `page.setContent()`)
- Use real Playwright (headless Chromium)

#### 4.3 Test flow: baseline → verify → evidence

```
1. Create task with selector + url
2. Create baseline.json (DOM snapshot)
3. Create simple HTML page with the target element
4. Start local HTTP server
5. Run verifyTask()
6. Check evidence files exist
7. Check system comment was written
8. Verify result shape
```

#### 4.4 Test scenarios

| Scenario | Setup | Expected |
| --- | --- | --- |
| **Happy path** | Baseline matches current state | `ok: true`, no changes |
| **Element changed** | Baseline has old HTML, current has new HTML | `ok: true`, `htmlChanged: true` |
| **Element removed** | Baseline exists, element not on page | `ok: false`, `selectorResolves: false` |
| **New console error** | Page logs error during load | `ok: false`, `newConsoleErrors: ["error"]` |
| **Auth state injected** | Task has auth state, page checks localStorage | Auth state present on page |
| **--url override** | Task URL differs from --url | Uses --url for navigation |
| **Baseline corrupt** | baseline.json contains invalid JSON | Throws `E_BASELINE_CORRUPT` |

#### 4.5 Test helper functions

- `createTestProject()` — sets up `.vibeflow/` structure
- `createBaseline(taskId, snapshot)` — writes baseline.json
- `startTestServer(html)` — starts HTTP server, returns port
- `cleanupTestProject(dir)` — removes temp directory

### Files to Create/Modify

- **Create**: `packages/cli/tests/integration/verify.test.ts`
- **Create**: `packages/cli/tests/integration/helpers.ts` — test utilities

### Risks

- Requires Playwright to be installed (`npx playwright install chromium`)
- Integration tests are slower than unit tests (~5-10s each)
- Need to handle server lifecycle (start/stop) in tests
- May need to adjust vitest config for integration test timeout

### Estimated Effort

4-5 hours (test file ~300-400 lines + helpers ~100 lines)

---

## Improvement 5: API Routes for Overlay → CLI Communication

### Current State

The overlay sends data to API routes that don't exist yet:

| Route | Purpose | Status |
| --- | --- | --- |
| `POST /api/tasks/:id/auth-state` | Store encrypted auth state | ❌ Missing |
| `POST /api/tasks/:id/baseline` | Store baseline snapshot | ❌ Missing |

The CLI server (`server/server.ts`) uses Express with routes defined via `app.get/post/...`.

### Plan

#### 5.1 Add `POST /api/tasks/:id/auth-state` route

```typescript
app.post("/api/tasks/:id/auth-state", express.json(), (req, res) => {
  // 1. Validate task ID
  // 2. Validate request body (authState + taskAuthor)
  // 3. Encrypt auth state with Node.js crypto (scrypt + AES-256-GCM)
  // 4. Write to .vibeflow/auth-state.<taskId>.enc
  // 5. Set chmod 600
  // 6. Return success
});
```

Implementation details:

- Import `encryptAuthState` from `core/auth.ts`
- Import `AuthState` type from `core/verification-types.ts`
- Use `writeFileSync` with `mode: 0o600` for the encrypted file
- Validate `taskAuthor` is present (needed for encryption key derivation)
- Handle errors gracefully (return 500 with error message)

#### 5.2 Add `POST /api/tasks/:id/baseline` route

```typescript
app.post("/api/tasks/:id/baseline", express.json(), (req, res) => {
  // 1. Validate task ID
  // 2. Validate request body (baseline DomSnapshot)
  // 3. Write to .vibeflow/tasks/files/<taskId>/baseline.json
  // 4. Update task's files array to include baseline.json
  // 5. Return success
});
```

Implementation details:

- Import `DomSnapshot` type from `core/verification-types.ts`
- Use `saveFile` from `core/files.ts` to write baseline
- Use `updateTask` from `core/tasks.ts` to add baseline to files array
- Validate baseline has required fields (selector, outerHTML, position)

#### 5.3 Add validation middleware

Create a shared validation function:

```typescript
function validateTaskId(id: string): boolean {
  return /^[a-f0-9]{30}$/.test(id);
}
```

#### 5.4 Add content-type validation

Both routes should:

- Check `Content-Type: application/json` header
- Parse body with `express.json()`
- Validate required fields exist
- Return 400 for invalid requests

#### 5.5 Add tests

Create `tests/unit/server/verification-routes.test.ts`:

- Test auth-state route: valid request → 200, file created
- Test auth-state route: missing taskAuthor → 400
- Test auth-state route: invalid task ID → 404
- Test baseline route: valid request → 200, file created
- Test baseline route: missing required fields → 400
- Test baseline route: invalid task ID → 404

### Files to Create/Modify

- **Modify**: `packages/cli/src/server/server.ts` — add 2 new routes
- **Create**: `packages/cli/tests/unit/server/verification-routes.test.ts`

### Risks

- Auth state encryption happens on the server side (Node.js) — this is correct per spec
- Need to ensure `chmod 600` works on all platforms (Linux/macOS)
- The overlay sends `taskAuthor` in the request body — need to validate it's a non-empty string

### Estimated Effort

2-3 hours

---

## Implementation Order

1. **Improvement 3: Overlay Types Dedup** (foundational — other improvements depend on shared types)
2. **Improvement 5: API Routes** (unblocks overlay → CLI communication)
3. **Improvement 1: verify.ts Unit Tests** (tests the core verification engine)
4. **Improvement 2: gating.ts Mutation Score** (improves test quality)
5. **Improvement 4: Integration Tests** (end-to-end validation)

## Total Estimated Effort

11-16 hours across all 5 improvements.

## Success Criteria

- [ ] `verify.ts` has 100% error code coverage
- [ ] `gating.ts` mutation score ≥ 85%
- [ ] No duplicated types between overlay and CLI
- [ ] Integration tests pass with real Playwright
- [ ] API routes handle auth-state and baseline payloads
- [ ] All existing tests still pass (718 unit + 91 e2e)
- [ ] Build succeeds with no type errors
