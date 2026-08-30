# Visual Verification Loop — Specification

> Status: Backlog (specification)
> Author: product research session (revised)
> Scope: CLI + overlay + task data model (web/SaaS follows the CLI data model)

## 1. Goal

Close the "agent says Done, but didn't actually fix the thing" loop by:

1. Capturing an immutable **baseline** at annotation time (DOM snapshot + element position).
2. Providing a **`vibeflow verify <id>`** command that re-renders the target via Playwright, diffs against the baseline, and returns structured evidence.
3. **Gating review status** on verification evidence.
4. Keeping the **LLM as the semantic judge** — Playwright proves *changed*, the agent judges *correct*.

## 2. Problem

Agents write code fast but are bad at *confirming their own output*. The recurring failure mode (validated across Reddit `r/ClaudeCode`, `r/cursor`) is:

> "You ask Claude to fix something, it says 'Done!', and you test it only to find it hasn't — and if it would just look at a screenshot it could see that."

Raw Playwright is a commodity: agents already *can* screenshot. What they lack is:

- **(a) A baseline** — the broken state is usually gone by the time the agent runs.
- **(b) A scoped assertion** — "did the specific element I clicked change the way I asked", not "does the app generally work".
- **(c) Auth handling** — most dev apps require login; a bare Playwright run sees the login page.

## 3. Architecture Overview

```text
┌─────────────────────────────────────────────────────────┐
│  ANNOTATION TIME (user's browser — overlay)             │
│                                                         │
│  1. User annotates element                              │
│  2. Overlay captures automatically:                     │
│     - DOM snapshot (baseline)                           │
│     - Element position (bounding box + context)         │
│     - URL, selector, source location                    │
│     - Cookies + storage state → encrypted file          │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  IMPLEMENTATION TIME (agents working)                   │
│                                                         │
│  - Agents edit code, save files                         │
│  - HMR fires in user's browser (side effect)            │
│  - Overlay does NOT verify — just waits                 │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  VERIFICATION TIME (Playwright — isolated)              │
│                                                         │
│  3. User asks agent to verify                           │
│  4. Agent calls `vibeflow verify <id>`                  │
│  5. Playwright: decrypt cookies → inject → navigate     │
│  6. Wait for selector → capture after snapshot          │
│  7. Diff baseline vs after (structural)                 │
│  8. Return structured result to agent                   │
│  9. Agent judges semantically → reports to user         │
└─────────────────────────────────────────────────────────┘
```

**Why Playwright as the verification engine (not overlay-based monitoring):**

| Property | Overlay (user's browser) | Playwright (isolated) |
| ---------- | -------------------------- | ---------------------- |
| Isolation | Shared with user's work session | Clean context, nothing else touching it |
| Determinism | User might scroll, click, navigate | Controlled: navigate → wait → capture |
| Multi-agent | HMR fires from all agents, can't attribute changes | Each verify run is a point-in-time snapshot |
| Reproducibility | Depends on current browser state | Can re-run identical verification |
| Auth | ✅ Already authenticated | ⚠️ Needs cookie injection (solved) |

## 4. Key Concepts

| Term | Meaning |
| ------ | --------- |
| **Baseline** | Immutable record of the element's state at annotation time: DOM snapshot + position context + structured metadata. |
| **DOM snapshot** | `outerHTML` + computed styles + selector + position context + viewport + `devicePixelRatio` + browser/OS. The *primary* baseline. |
| **Verification** | `vibeflow verify <id>` uses Playwright to re-render the target, re-capture the snapshot, diff against baseline, and produce an evidence bundle. |
| **Evidence** | Verification artifacts (before snapshot, after snapshot, diff, console errors, task context) bundled for LLM judgment. |
| **Auth state** | Encrypted cookies + localStorage + sessionStorage captured automatically at annotation time, used to authenticate Playwright during verification. Per-task keyed. |

## 5. What We Already Capture

At annotation time the overlay already resolves and stores on the `Task`:

- `selector` + `cssSelector`
- `url`, `file`, `line`, `col`, `component` (source location)
- `annotatedElementText` (inner text, max 300 chars)
- `screenshot` (optional, user-triggered)
- console errors / failed requests via `overlay-browser/error-recorder.ts`

**Gaps (addressed by this spec):**

- No frozen `outerHTML` + computed-style snapshot
- No element position context (scroll, z-index, viewport placement)
- No verification step
- No auth state capture for Playwright re-rendering

## 6. Baseline Capture (Overlay — at annotation time)

At annotation time, when the user annotates an element, the overlay captures a **DOM snapshot** and **element position context** automatically (no extra user action beyond annotation):

```ts
interface DomSnapshot {
  outerHTML: string;                    // frozen element.outerHTML at click
  computedStyles: Record<string, string>; // getComputedStyle(el), resolved values
  selector: string;                     // existing cssSelector
  xpath?: string;
  position: PositionContext;            // element position context (§6.1)
  parentSnippet?: string;               // nearest ancestor outerHTML (structural context)
  browser: string;                       // UA-derived
  consoleErrors: string[];               // from error-recorder at capture time
  capturedAt: string;                    // ISO timestamp
}
```

When multiple elements match the selector, the overlay uses the exact clicked element's full CSS path for disambiguation (e.g. `#app > div.container > button.submit` instead of just `button.submit`).

**Why DOM over pixels:** the agent greps and edits code — it needs structure, not pixels. A snapshot is deterministic, zero-fidelity-risk, and diffable structurally (`outerHTML` diff, per-property computed-style diff) with no subpixel noise.

**Storage:** snapshot persisted as a task file under `.vibeflow/files/<taskId>/baseline.json` via the existing `files` / `TaskFileRef[]` mechanism. The `files` path is preferred — it already flows through CLI, web, push, and SaaS sync without new plumbing.

### 6.1 Element Position Context

```ts
interface PositionContext {
  boundingBox: { x: number; y: number; width: number; height: number };
  scrollPosition: { x: number; y: number };
  viewport: { width: number; height: number; dpr: number };
  stackingContext: {
    zIndex: string;
    position: string;                   // static | relative | absolute | fixed | sticky
    parentZIndex?: string;
  };
}
```

This answers: "where was the element and what was around it?" — useful for detecting layout shifts.

> **Phase 2 additions:** `isVisible` (derivable from boundingBox + viewport at verification time) and `clipRect` (overflow clipping) are deferred to keep v1 simple.

## 7. Auth State Capture (Overlay — at annotation time)

At annotation time, the overlay captures the user's browser auth state and encrypts it for Playwright reuse.

### 7.1 What to capture

```ts
interface AuthState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
  }>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}
```

Captured from:

- `document.cookie` (accessible cookies)
- `Object.keys(localStorage)` + values
- `Object.keys(sessionStorage)` + values

> **⚠️ Known v1 limitation — HttpOnly cookies:** JavaScript in the overlay cannot read HttpOnly cookies (e.g. Rails `session_id`, Django `sessionid`, Express `connect.sid`). For auth systems that rely on HttpOnly session cookies, the capture will be incomplete and Playwright verification will fail at the login redirect. Most dev environments use JWT in localStorage or non-HttpOnly cookies, which work fine. **Future mitigation:** Chrome extension for full cookie access (Phase 2).

### 7.2 Encryption design

Store encrypted auth state at `.vibeflow/auth-state.<taskId>.enc` (per-task keyed to allow multiple tasks on different origins to coexist).

The encryption key is derived from `Task.author` (the Git username of the task author):

```ts
import crypto from 'crypto';

function encryptAuthState(authState: AuthState, taskAuthor: string): EncryptedAuthState {
  // Derive key from task author + salt
  const salt = 'vibeflow-auth-v1';
  const key = crypto.scryptSync(taskAuthor, salt, 32);

  // Encrypt with AES-256-GCM (authenticated encryption)
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(authState);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h TTL
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

interface EncryptedAuthState {
  version: number;
  createdAt: string;
  expiresAt: string;
  iv: string;
  tag: string;
  data: string;
}
```

> **Note:** The fixed salt `vibeflow-auth-v1` is acceptable for v1 local dev tooling. Future: random per-file salt stored alongside IV.

> **Stability guarantee:** `Task.author` must be stable between annotation (capture) and verification (decrypt). This is guaranteed by the task data model — author is set at creation and does not change.

### 7.3 Data locality

Auth state is **local-only** and must never leave the machine:

| Data | Local storage | Pushed to SaaS |
| ---- | --------------- | -------------- |
| Auth state (cookies, storage) | `.vibeflow/auth-state.<taskId>.enc` | ❌ Never |
| Baseline snapshot | `.vibeflow/files/<taskId>/baseline.json` | ✅ Via `files` sync |
| Verification evidence | `.vibeflow/files/<taskId>/verify-*.json` | ✅ Via `files` sync |

The overlay sends baseline snapshots to the local CLI server (not directly to the SaaS API). When `vibeflow push` runs, baseline snapshots and verification evidence files are synced — the per-task encrypted auth state files stay on disk.

### 7.4 Security requirements

| Requirement | Implementation |
| ------------- | --------------- |
| Encrypted at rest | AES-256-GCM (authenticated encryption — detects tampering) |
| Key derivation | `crypto.scryptSync(taskAuthor, 'vibeflow-auth-v1', 32)` |
| File permissions | `chmod 600` on `.vibeflow/auth-state.<taskId>.enc` |
| Auto-expiry | 24h TTL — `expiresAt` checked at decryption time |
| Manual wipe | `vibeflow auth --clear` deletes all per-task encrypted auth files |
| No logging | Cookies/redacted values never appear in error messages or debug output |

### 7.5 Decryption flow (Playwright verify)

```ts
function decryptAuthState(encrypted: EncryptedAuthState, taskAuthor: string): AuthState | null {
  // Check expiry
  if (new Date(encrypted.expiresAt) < new Date()) {
    return null; // expired, user must re-annotate
  }

  const salt = 'vibeflow-auth-v1';
  const key = crypto.scryptSync(taskAuthor, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, 'hex')),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString());
}
```

## 8. Verification — `vibeflow verify <id>`

A new CLI subcommand (CLI-first, consistent with `tasks`/`kanban`). Runs from the project root.

### 9.1 CLI interface

```bash
vibeflow verify <id>            # verify one task
vibeflow verify <id> --json     # machine-readable result
vibeflow verify <id> --url ...  # override target URL (e.g. dev server differs from annotated URL)
```

> **Note:** `--url` override is for same-origin port changes only (e.g. `localhost:5173` → `localhost:3001`). Different-origin overrides will fail cookie injection.

### 9.2 Verification flow

```text
1. Read task + baseline snapshot + per-task encrypted auth state
2. Decrypt auth state (Task.author + salt) — fail → "auth expired, re-annotate"
3. Spawn Playwright (headless Chromium)
4. Check Playwright browser is installed — fail → "Run: npx playwright install chromium"
5. Create browser context with baseline viewport + deviceScaleFactor
6. Inject decrypted cookies + storage into browser context
7. Navigate to task.url (or --url override)
8. Wait for cssSelector to resolve (timeout 10s → fail: "target not found")
9. Re-capture DOM snapshot at the same selector (same shape as §6)
10. Capture console errors during page load + idle (2s)
11. Compute structural diff:
    - selector resolves? (boolean)
    - outerHTML changed vs baseline? (text/structure)
    - computed styles changed vs baseline? (per-property)
    - bounding box changed? (position/size shift)
    - new console errors vs baseline?
12. Bundle evidence: before snapshot, after snapshot, diff, console errors, task context
13. Return structured result (JSON or human-readable)
14. Write system comment on task with summary
```

### 9.3 Result shape

`ok: true` means the **mechanical checks passed** (selector resolved, no new console errors, element found). Semantic judgment — did the fix actually accomplish the goal? — is a separate step where the LLM reads the task description and reasons about correctness.

```json
{
  "taskId": "b5312f5fd7d8903a45b1fb98e365b6",
  "ok": true,
  "taskDescription": "Fix submit button color to blue",
  "baseline": {
    "selector": ".submit-btn",
    "url": "http://localhost:5173/form",
    "capturedAt": "2026-08-28T22:07:00.000Z",
    "snapshot": { "...DomSnapshot..." }
  },
  "after": {
    "snapshot": { "...DomSnapshot..." },
    "consoleErrors": []
  },
  "diff": {
    "selectorResolves": true,
    "htmlChanged": true,
    "stylesChanged": {
      "background-color": ["#EF4444", "#3B82F6"],
      "color": ["#FFFFFF", "#FFFFFF"]
    },
    "positionChanged": false,
    "newConsoleErrors": []
  },
  "evidenceFiles": [
    ".vibeflow/files/<taskId>/baseline.json",
    ".vibeflow/files/<taskId>/verify-after.json",
    ".vibeflow/files/<taskId>/verify-diff.json",
    ".vibeflow/files/<taskId>/verify-console.txt"
  ],
  "verdict": "element changed — background-color moved from red to blue, no regressions"
}
```

### 9.4 Error handling

| Error | Behavior |
| ------- | ---------- |
| No baseline exists | "Task has no baseline. Re-annotate to capture one." |
| Auth expired (>24h) | "Auth state expired. Re-annotate to capture fresh cookies." |
| Auth decrypt fails | "Auth state corrupted. Re-annotate." |
| App not running (connection refused) | "Cannot connect to {url}. Is the dev server running?" |
| Selector not found (timeout) | "Target element not found at {selector}. The fix may have renamed/removed it." (This is a useful signal — the fix changed the DOM structure.) |
| Chromium not installed | "Run: `npx playwright install chromium`" |
| Playwright crash | "Verification failed: {error}. Try again." |
| Multiple elements match selector | "Selector matches {n} elements. The selector may need to be more specific." |

### 9.5 Task description as acceptance criteria

The result includes `taskDescription` so the LLM has the full task context to reason against. There is no separate `acceptanceCriteria` field — the task description IS the acceptance criteria. The LLM reads the task, compares the before/after snapshots and diff, and determines whether the fix accomplishes the stated goal.

The agent reads the structured result and applies semantic judgment:

> "The task asked for blue (#3B82F6). The diff shows background-color changed from #EF4444 to #3B82F6. This matches what was requested. ✅ Verified."

Or:

> "The task asked for blue. The diff shows background-color changed from red to green. This does not match. ❌ Not verified — needs fix."

## 9. Verification Layers

| Layer | Who | What | Automated |
| ------- | ----- | ------ | ----------- |
| **Mechanical** | `vibeflow verify` (Playwright) | Selector resolves? Snapshot changed? Console clean? Position stable? | Yes |
| **Semantic** | LLM agent | Before/after + task intent → "did this fix accomplish the goal? Any regressions?" | Agent reads result |
| **Human** | reviewer | Final glance. Verification evidence makes the review trustworthy. | No |

A structural diff proves *changed*, not *correct*. Correctness stays with the agent's semantic judgment + human approval.

**Why this layering works:**

- Mechanical layer is cheap (Playwright run, ~2-5s) and catches the obvious case ("agent didn't even touch the element").
- Semantic layer uses the LLM's understanding of intent to judge correctness ("did it fix the right thing?").
- Human layer is the final safety net. Verification evidence means the human isn't reviewing blind.

## 10. Multiple Agents

Each `verify` run is an independent, point-in-time snapshot. This handles the multi-agent case correctly:

- Agent A changes component X → HMR fires → element state updates
- Agent B changes component Y → HMR fires → element state updates further
- `vibeflow verify <taskA>` → Playwright captures current state → diffs against baseline
- `vibeflow verify <taskB>` → Playwright captures current state → diffs against baseline

If multiple agents modify the same element, the last verify sees the combined result. This is correct — we're verifying "is the element fixed now", not "which agent fixed it".

**No attribution needed.** The verification is about the *current state vs baseline*, not about tracking individual agent contributions.

## 11. Workflow Gating

- **`review` status is blocked** until a verification evidence file exists on the task. This mirrors the existing rule that review requires a commit message + implementation report.
- **`verify` may run at any status**, but its result is advisory until the task is `in-progress` or `review`.
- When an agent attempts `tasks --edit <id> --set-status review`, the CLI checks for verification evidence. If missing: "Cannot move to review — run `vibeflow verify <id>` first."

## 12. Data Model Changes

### 13.1 CLI Task (types.ts)

No new fields needed on the Task type. All verification data lives in the `files` array (`TaskFileRef[]`) using filename conventions:

| File | Purpose |
| ---- | ------- |
| `baseline.json` | `DomSnapshot` + `PositionContext` + metadata. Presence = task has a baseline. |
| `verify-after.json` | `DomSnapshot` after verification run |
| `verify-diff.json` | Structural diff result |
| `verify-console.txt` | Console errors during verification |

Baseline metadata is stored inside `baseline.json`.

### 13.2 Web tasks (schema.ts)

No schema migration needed. Verification data flows through the existing `files` / `TaskFileRef[]` mechanism — the same path that handles screenshots and other task attachments. Baseline snapshots and verification evidence sync to SaaS via `vibeflow push` like any other task file.

### 13.3 Auth state

Stored separately from task files: `.vibeflow/auth-state.<taskId>.enc` (per-task keyed). Not part of `Task.files` — it's project-level, not task-level, and never syncs to SaaS.

## 13. Screenshot Strategy — OPTIONAL (user-provided only, for now)

Screenshots remain **optional and user-provided**. No automatic screenshot capture in this phase.

**Rationale:**

1. The DOM snapshot fully covers the agent's needs (locate + understand + diff).
2. Automatic pixel capture has reliability/permission/taint problems, and a pixel diff proves "changed", not "correct" — so it is a *human/vision* aid, never the correctness gate.
3. Keeps the feature deterministic and noise-free.

Screenshots are used only for the human `review` glance and the optional vision-model "does it look right" pass.

### 14.1 Future: automatic capture via CDP

Documented for future reference; **not** part of this phase. Recommended order:

1. **CDP `Page.captureScreenshot` (clip)** — best fidelity, requires Playwright `connectOverCDP` in CLI mode.
2. **`modern-screenshot`** — in-page fallback via SVG `foreignObject`.
3. Avoid `html2canvas` — re-implements paint, breaks on modern CSS.

## 14. CLI Commands

```bash
# Verification
vibeflow verify <id>            # verify one task (Playwright, isolated)
vibeflow verify <id> --json     # machine-readable result
vibeflow verify <id> --url ...  # override target URL (same-origin port change only)

# Auth management
vibeflow auth --clear           # wipe all per-task stored auth cookies

# Task integration (existing, with new gating)
vibeflow tasks --edit <id> --set-status review  # now checks for verification evidence
```

## 15. Implementation Phases

### Phase 1 (this spec)

- Baseline capture in overlay (DOM snapshot + position)
- Auth state capture + encryption (per-task keyed)
- Baseline capture + auth capture (automatic at annotation time)
- `vibeflow verify <id>` CLI command (Playwright, headless)
- Structural diff engine
- Evidence file storage via `Task.files` / `TaskFileRef[]`
- Review gating (requires verification evidence)
- `vibeflow auth --clear`

### Phase 2 (future)

- Automatic baseline screenshot via CDP (CLI mode)
- `verify --all` to verify entire in-progress column
- Vision-model verification pass (feed baseline + after + intent, let agent judge)
- User-journey capture (record multi-step clicks)
- Chrome extension for full HttpOnly cookie access

## 16. Open Questions

1. **Dev server lifecycle:** Should `verify` assume the app is running, or spin up a dev server? (Phase 1: assume it's already running. Document the assumption. Future: detect and start via `vibeflow dev`.)
2. **SPA route changes:** How to handle cases where HMR changes routing and the annotated element moves to a different URL? (Current approach: Playwright navigates to the original URL. If the element isn't there, "target not found" is the correct signal — the route changed and the fix needs re-annotation.)
3. **Overlay auto-navigation:** Should the overlay auto-navigate to the correct URL when annotating? (Phase 1: no. User manually navigates. Future: could prompt "Navigate to /dashboard/users to verify task X".)
4. **Selective verification:** Should verify check only the annotated element, or also verify surrounding elements weren't regressed? (Phase 1: annotated element only. Future: configurable scope — "verify element + nearest siblings".)
5. **SaaS push behavior:** Should verification evidence be auto-pushed to SaaS, or only on explicit `vibeflow push`? (Phase 1: only on explicit push. Future: auto-push on verify completion.)
