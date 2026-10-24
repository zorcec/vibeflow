import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  renameSync,
  openSync,
  statSync,
} from "node:fs";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Task, TaskStatus, TaskComment } from "./types.js";
import {
  PROTO_DIR,
  TASKS_DIR,
  FILES_DIR,
  SCREENSHOTS_DIR,
  TASK_STATUSES,
} from "./types.js";
import type { FileInfo } from "./files.js";
import { taskLockPath, withFileLockSync } from "./lock.js";
import { getDescendants } from "./task-links.js";
import {
  loadFreshChildrenIndex,
  refreshChildrenIndex,
  invalidateChildrenIndexLocked,
  type ChildEdge,
  type TaskChildrenIndex,
} from "./task-children-index.js";
import { selectClaimCandidate } from "./claim-eligibility.js";
import { inspectLocalTaskRecord, type TaskRecordFinding, type TaskReadFinding, type LocalTaskRecordRead } from "./task-record-read.js";
export { taskReadNotices } from "./task-record-read.js";
import { generateSortKeyBetween } from "@vibeflow-tools/ui/kanban";

export function generateTaskId(): string {
  // 15 random bytes → 30-char lowercase hex, 120 bits of entropy — essentially zero collision probability
  return randomBytes(15).toString("hex");
}

/**
 * A Research task produces a report; it has no annotated UI element to verify,
 * so the `verified` attestation (and the tri-state UI it drives) does not apply
 * to it. See the read and write scrubbers below and `review-gate.ts`.
 */
export function isResearchType(type: string | undefined): boolean {
  return (type ?? "").toLowerCase() === "research";
}

// ── Directory helpers ──────────────────────────────────────────────────────
export function getTasksDir(projectDir: string): string {
  return join(projectDir, PROTO_DIR, TASKS_DIR);
}

function migrateLegacyTaskAssetFolders(projectDir: string): void {
  const protoRoot = join(projectDir, PROTO_DIR);
  const legacyFilesDir = join(protoRoot, "files");
  const nextFilesDir = join(protoRoot, FILES_DIR);
  const legacyScreenshotsDir = join(protoRoot, "screenshots");
  const nextScreenshotsDir = join(protoRoot, SCREENSHOTS_DIR);

  if (existsSync(legacyFilesDir)) {
    mkdirSync(nextFilesDir, { recursive: true });
    for (const entry of readdirSync(legacyFilesDir)) {
      const from = join(legacyFilesDir, entry);
      const to = join(nextFilesDir, entry);
      if (existsSync(to)) continue;
      try {
        renameSync(from, to);
      } catch {
        /* ignore migration collisions */
      }
    }
  }

  if (existsSync(legacyScreenshotsDir)) {
    mkdirSync(nextScreenshotsDir, { recursive: true });
    for (const entry of readdirSync(legacyScreenshotsDir)) {
      const from = join(legacyScreenshotsDir, entry);
      const to = join(nextScreenshotsDir, entry);
      if (existsSync(to)) continue;
      try {
        renameSync(from, to);
      } catch {
        /* ignore migration collisions */
      }
    }
  }
}

export function ensureTaskDirs(projectDir: string): void {
  migrateLegacyTaskAssetFolders(projectDir);
  mkdirSync(getTasksDir(projectDir), { recursive: true });
  mkdirSync(join(projectDir, PROTO_DIR, SCREENSHOTS_DIR), { recursive: true });
}

// ── JSON-based storage helpers ─────────────────────────────────────────────

/** Extracts the YYYY-MM-DD date component from an ISO date string. */
function getDateSubdir(isoDate: string): string {
  return isoDate.slice(0, 10);
}

/**
 * Returns the canonical JSON file path for a task.
 * When `created` is provided, the file lives in a date subdirectory.
 * Falls back to the flat layout when no date is given (legacy lookup).
 */
export function getTaskFilePath(
  projectDir: string,
  taskId: string,
  created?: string,
): string {
  const tasksDir = getTasksDir(projectDir);
  if (created) {
    return join(tasksDir, getDateSubdir(created), `${taskId}.json`);
  }
  return join(tasksDir, `${taskId}.json`);
}

/**
 * Resolves the actual path of an existing task file by ID.
 * Searches date subdirectories first, then falls back to the legacy flat layout.
 */
export function findTaskFilePath(
  projectDir: string,
  taskId: string,
): string | null {
  const tasksDir = getTasksDir(projectDir);
  if (!existsSync(tasksDir)) return null;

  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = join(tasksDir, entry.name, `${taskId}.json`);
      if (existsSync(candidate)) return candidate;
    } else if (entry.name === `${taskId}.json`) {
      return join(tasksDir, entry.name);
    }
  }
  return null;
}

/**
 * The task-id resolution RULE: a full id, or a prefix of one. Exact id first
 * (the equality arm wins on an exact match by list order), then prefix.
 *
 * Split out from `findTaskByIdOrPrefix` because two callers resolve against a
 * task list that is NOT the local store — the SaaS task list in `tasks --get`,
 * and `listTasksWithPaths` (whose `filePath` the caller needs). Inlining the
 * expression at those sites is what let the CLI, the HTTP route and the MCP
 * tools drift apart; they all call this instead.
 */
export function matchesIdOrPrefix(
  task: { id: string },
  idOrPrefix: string,
): boolean {
  return task.id === idOrPrefix || task.id.startsWith(idOrPrefix);
}

/**
 * Find a task by its FULL id OR by an id prefix — the CLI's long-standing
 * resolution rule: first match in list order, exact id included. Every
 * surface (CLI, HTTP route, MCP operations) resolves through this or through
 * `resolveTaskId` below.
 */
export function findTaskByIdOrPrefix(
  projectDir: string,
  idOrPrefix: string,
): Task | undefined {
  return listTasks(projectDir).find((t) => matchesIdOrPrefix(t, idOrPrefix));
}

/**
 * Resolve a full task id OR a unique-ish id prefix to the full id. The input
 * is returned UNCHANGED when nothing matches, so every caller keeps its own
 * "not found" wording (and its own fallback) instead of this helper inventing
 * a second one.
 */
export function resolveTaskId(projectDir: string, idOrPrefix: string): string {
  return findTaskByIdOrPrefix(projectDir, idOrPrefix)?.id ?? idOrPrefix;
}

function normalizeComment(c: Record<string, unknown>): TaskComment {
  // SAFETY: raw comment JSON objects conform to TaskComment shape after normalization.
  // `...raw` first so UNKNOWN keys on the persisted comment survive the
  // read → write round trip; only the known fields below are rewritten.
  const raw = c as unknown as TaskComment;
  const out: TaskComment = {
    ...raw,
    text:
      (c.text as string | undefined) ?? (c.content as string | undefined) ?? "",
  };
  // Attribution email: keep any non-empty string byte-for-byte; otherwise the
  // key must be ABSENT (never null, never ""). `delete` rather than assigning
  // undefined: an own key holding undefined still makes `'authorEmail' in
  // comment` true, which is not the same as "no email recorded".
  if (typeof out.authorEmail !== "string" || out.authorEmail.trim().length === 0) {
    delete out.authorEmail;
  }
  return out;
}

/** Filters a raw persisted user-id list, keeping only non-empty strings. */
function normalizeUserIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

/** Free-form labels are data; only empties/non-strings/stringified artifacts are absent. */
export function normalizeTaskTypeValue(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (t.length === 0) return undefined;
  // A stringified object is stringification garbage, never a label: no
  // writer deliberately stores `[object Object]` as a task type (the same
  // shape `shouldDropTypeValue` below refuses to keep).
  if (/^\[object .+\]$/.test(t)) return undefined;
  return raw;
}

/** Artifact-only deletion rule; an unknown non-empty label is never junk. */
export function shouldDropTypeValue(raw: unknown): boolean {
  return normalizeTaskTypeValue(raw) === undefined;
}

/**
 * Schema-boundary normalizer for the persisted top-level `links` field.
 *
 * Returns the filtered link list when at least one well-formed entry
 * survives, else ABSENT (`undefined`) — a non-array, an empty array, or an
 * array with zero valid entries carries no links and must not survive a
 * normalising write as a stray key. Partially-valid arrays are returned
 * filtered (same rule `normalizeTask` always applied); the `--normalize`
 * planner only drops the key when the WHOLE value normalizes to absent and
 * never rewrites a partially-valid array it does not fully understand.
 *
 * Display helper; canonical read repair is defined in task-record-read.ts.
 */
export function normalizeTaskLinksValue(raw: unknown): Task["links"] {
  if (!Array.isArray(raw)) return undefined;
  const result = (raw as Record<string, unknown>[])
    .filter((l) => {
      if (!l || typeof l !== "object") return false;
      const taskId = l.taskId;
      const type = l.type;
      return (
        typeof taskId === "string" &&
        taskId.length > 0 &&
        typeof type === "string" &&
        ("parent" === type || "relates" === type || "blocks" === type)
      );
    })
    .map((l) => ({
      // Spread preserves unknown keys on the link entry.
      ...l,
      taskId: String(l.taskId),
      type: String(l.type) as import("./types.js").TaskLinkType,
    }));
  return result.length > 0 ? result : undefined;
}

function normalizeTask(raw: Record<string, unknown>): Task {
  const normalizedType = normalizeTaskTypeValue(raw.type);

  // Presentation normalization, NOT record reconstruction: the persisted
  // record is the lossless mirror push uploads, so `...raw` comes FIRST and
  // unknown/extra keys (legacy fields, fields from newer writers, keys this
  // build does not know) survive read → write untouched. Only the known
  // fields below are rewritten for display; explicit `undefined` overrides
  // drop a known key that normalization decides must be absent (serializes
  // as a removed key — never null, never ""). The two schema-boundary
  // fields (`type`, `links`) go further: when they normalize to absent the
  // key is DELETED outright (see below), so no writer — `updateTask`, pull
  // merge, `--normalize` — can resurrect a value the schema does not allow.
  // `type` normalizes to absent only for values that can never be
  // deliberate (non-strings, empties, stringified artifacts); a real label
  // survives verbatim. Every other unknown key keeps the long-standing
  // mirror behavior.
  const out: Task = {
    ...raw,
    id: String(raw.id ?? ""),
    title: String(raw.title ?? "Untitled"),
    description: String(raw.description ?? ""),
    status: ((TASK_STATUSES as readonly string[]).includes(raw.status as string)
      ? raw.status
      : "todo") as TaskStatus,
    url: raw.url ? String(raw.url) : undefined,
    selector: (() => {
      const sel = String(raw.selector ?? "/");
      // Legacy migration: old tasks stored file:line as selector without a separate cssSelector.
      // When cssSelector is present, the task was created by the modern system that tracks
      // both selector and cssSelector independently — do NOT overwrite the selector in that case.
      if (raw.file && !raw.cssSelector && sel.startsWith(String(raw.file))) {
        return raw.url ? String(raw.url) : "/";
      }
      return sel;
    })(),
    cssSelector:
      raw.cssSelector && String(raw.cssSelector) !== String(raw.selector ?? "/")
        ? String(raw.cssSelector)
        : undefined,
    file: raw.file ? String(raw.file) : undefined,
    line: raw.line == null ? undefined : Number(raw.line),
    col: raw.col == null ? undefined : Number(raw.col),
    component: raw.component ? String(raw.component) : undefined,
    type: normalizedType,
    priority: raw.priority ? String(raw.priority) : undefined,
    ...(raw.reportBack === true && { reportBack: true }),
    agent: raw.agent ? String(raw.agent) : undefined,
    model: raw.model ? String(raw.model) : undefined,
    author: raw.author ? String(raw.author) : undefined,
    // Task-level attribution email (optional, additive, never inferred from
    // commits). Keep any non-empty string as-is; anything else becomes
    // absent. Missing stays missing.
    authorEmail:
      typeof raw.authorEmail === "string" && raw.authorEmail.trim().length > 0
        ? raw.authorEmail
        : undefined,
    commits: Array.isArray(raw.commits)
      ? (raw.commits as Record<string, unknown>[]).map((c) => ({
          // Spread preserves unknown keys (and `authorEmail`) on the commit
          // entry; the three known fields keep their long-standing defaults.
          ...c,
          sha: String(c.sha ?? ""),
          message: String(c.message ?? ""),
          timestamp: String(c.timestamp ?? new Date().toISOString()),
          authorEmail:
            typeof c.authorEmail === "string" &&
            c.authorEmail.trim().length > 0
              ? c.authorEmail
              : undefined,
        }))
      : undefined,
    created: String(raw.created ?? new Date().toISOString()),
    updated: raw.updated ? String(raw.updated) : undefined,
    comments: Array.isArray(raw.comments)
      ? (raw.comments as Record<string, unknown>[]).map((c) =>
          normalizeComment(c),
        )
      : [],
    files: Array.isArray(raw.files)
      ? (raw.files as Array<Record<string, unknown> | string>)
          .map((f) => {
            if (typeof f === "string") {
              return { name: f, addedAt: new Date().toISOString() };
            }
            // Spread preserves unknown keys on the file entry too.
            return {
              ...f,
              name: String(f.name ?? ""),
              addedAt: String(f.addedAt ?? new Date().toISOString()),
              linkedPath: f.linkedPath ? String(f.linkedPath) : undefined,
              mimeType: f.mimeType ? String(f.mimeType) : undefined,
              // Engine-provenance flag: absent/false = user file. Must
              // survive normalization or every read drops the grouping.
              system: f.system === true ? true : undefined,
            };
          })
          .filter((f) => f.name)
      : [],
    screenshot: raw.screenshot ? String(raw.screenshot) : undefined,
    annotatedElementText: raw.annotatedElementText
      ? String(raw.annotatedElementText)
      : undefined,
    tags: Array.isArray(raw.tags)
      ? (raw.tags as unknown[]).filter(
          (t): t is string => typeof t === "string" && t.length > 0,
        )
      : undefined,
    sortKey: raw.sortKey ? String(raw.sortKey) : undefined,
    // Tri-state: true = last verify passed, false = last verify FAILED,
    // undefined = never verified. Absence must survive normalization —
    // collapsing it to false would erase the failed/never-verified distinction
    // the kanban UI relies on (see the three-state verify indicator).
    //
    // Research tasks NEVER carry a verdict: they have no UI to verify, so any
    // boolean here is meaningless — and under tri-state semantics a stale
    // `false` reads as "verified as NOT implemented correctly", an active lie.
    // Force absence here whatever wrote the value, so the invariant survives
    // legacy data, hand edits, and any writer that bypasses the write scrub.
    verified: isResearchType(normalizedType)
      ? undefined
      : typeof raw.verified === "boolean"
        ? raw.verified
        : undefined,
    branchName: raw.branchName ? String(raw.branchName) : undefined,
    baseline:
      raw.baseline && typeof raw.baseline === "object"
        ? (raw.baseline as import("./verification-types.js").DomSnapshot)
        : undefined,
    authStateEnc: raw.authStateEnc ? String(raw.authStateEnc) : undefined,
    links: normalizeTaskLinksValue(raw.links),
    // Per-user state must survive every read-modify-write round-trip;
    // normalizeTask is the single gateway for both.
    openedBy: normalizeUserIds(raw.openedBy),
    expandedBy: normalizeUserIds(raw.expandedBy),
  };
  // Schema boundary: a `type` that can never be deliberate (non-string,
  // empty, stringified artifact) and a `links` value that carries no links
  // are ABSENT — delete the key rather than leaving an own key holding
  // `undefined`. Serializers drop both identically, but in-memory `"type"
  // in task` must also read absent: the pull merge keys off presence, and
  // presence of a garbage value is what kept it "local-wins" on every
  // pull instead of converging. A real label (even outside the documented
  // vocabulary) is kept verbatim and is never deleted here.
  if (out.type === undefined) delete out.type;
  if (out.links === undefined) delete out.links;
  return out;
}

// ── Store maintenance: `tasks --normalize` ─────────────────────────────────
// The SAME closed repair rules feed read candidates and explicit disk repair.
// Unknown fields, conflicting aliases, future versions and corrupt JSON remain
// quarantined: normalisation is not permission to discard deliberate data.
export type TaskNormalizeFieldChange = TaskRecordFinding;

export interface TaskNormalizePlan {
  id: string;
  filePath: string;
  changes: TaskNormalizeFieldChange[];
}

export interface TaskNormalizeReport {
  changes: TaskNormalizePlan[];
  unreadable: string[];
  quarantined: TaskReadFinding[];
}

function isTaskJsonFile(name: string): boolean {
  return extname(name) === ".json" && !name.endsWith(".auth.json");
}

/** Raw traversal shared by enumeration and maintenance, excluding sidecars. */
function listTaskRawFiles(projectDir: string): Array<{ filePath: string; text: string }> {
  const tasksDir = getTasksDir(projectDir);
  if (!existsSync(tasksDir)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const dateDir = join(tasksDir, entry.name);
      for (const file of readdirSync(dateDir)) {
        if (isTaskJsonFile(file)) paths.push(join(dateDir, file));
      }
    } else if (isTaskJsonFile(entry.name)) paths.push(join(tasksDir, entry.name));
  }
  return paths.map((filePath) => {
    try { return { filePath, text: readFileSync(filePath, "utf-8") }; }
    catch { return { filePath, text: "" }; }
  });
}

export function planTaskStoreNormalize(projectDir: string): TaskNormalizeReport {
  const changes: TaskNormalizePlan[] = [];
  const unreadable: string[] = [];
  const quarantined: TaskReadFinding[] = [];
  for (const { filePath, text } of listTaskRawFiles(projectDir)) {
    let raw: unknown;
    try { raw = JSON.parse(text) as unknown; }
    catch { unreadable.push(filePath); continue; }
    const read = inspectLocalTaskRecord(raw);
    const id = taskFileId(filePath, raw);
    if (!read.record) {
      quarantined.push({ id, quarantined: true, findings: read.findings, issues: read.issues });
    } else if (read.findings.length > 0) {
      changes.push({ id, filePath, changes: read.findings });
    }
  }
  changes.sort((a, b) => a.id.localeCompare(b.id));
  quarantined.sort((a, b) => a.id.localeCompare(b.id));
  unreadable.sort();
  return { changes, unreadable, quarantined };
}

/** Atomic, lock-protected repair; re-read under lock, never stamp `updated`. */
export function applyTaskStoreNormalize(projectDir: string): {
  applied: TaskNormalizePlan[];
  unwritten: string[];
  unreadable: string[];
  quarantined: TaskReadFinding[];
} {
  const plan = planTaskStoreNormalize(projectDir);
  const applied: TaskNormalizePlan[] = [];
  const unwritten: string[] = [];
  for (const item of plan.changes) {
    try {
      withFileLockSync(taskLockPath(projectDir, item.id), () => {
        const text = readFileSync(item.filePath, "utf-8");
        const read = inspectLocalTaskRecord(JSON.parse(text) as unknown);
        if (!read.record) { unwritten.push(item.id); return; }
        if (read.findings.length === 0) return;
        const next = JSON.stringify(read.record, null, 2) + (text.endsWith("\n") ? "\n" : "");
        const tmp = item.filePath + ".tmp";
        writeFileSync(tmp, next, "utf-8");
        renameSync(tmp, item.filePath);
        applied.push({ ...item, changes: read.findings });
      });
    } catch { unwritten.push(item.id); }
  }
  // Normalisation repairs records and can drop or rewrite parent links:
  // invalidate (outside the per-task locks above) so the next cascade
  // rebuilds once instead of trusting a map built from pre-repair edges.
  if (applied.length > 0) invalidateChildrenIndexLocked(projectDir);
  return { applied, unwritten, unreadable: plan.unreadable, quarantined: plan.quarantined };
}

/**
 * Push preflight (ae9e99fd): return a snapshot only AFTER missing comment ids
 * have been atomically persisted under the task lock. A failed repair/write
 * aborts the push with its task id; listing's quarantine/skip policy is unsafe
 * here. Dry-run validates the same snapshot but must not write anything.
 */
export function prepareTaskRecordsForPush(projectDir: string, reads: TaskReadFinding[] = [], dryRun = false): Array<Task & { filePath: string }> {
  return listTaskRawFiles(projectDir).map(({ filePath }) => {
    const id = taskFileId(filePath);
    try {
      return withFileLockSync(taskLockPath(projectDir, id), () => {
        const text = readFileSync(filePath, "utf-8");
        const raw: unknown = JSON.parse(text);
        const read = inspectLocalTaskRecord(raw);
        if (!read.record) {
          throw new Error(read.issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; "));
        }
        const minted = read.findings.some((finding) => finding.rule === "mint-comment-id");
        if (minted && !dryRun) {
          const tmp = filePath + ".tmp";
          writeFileSync(tmp, JSON.stringify(read.record, null, 2) + (text.endsWith("\n") ? "\n" : ""), "utf-8");
          renameSync(tmp, filePath);
        } else if (read.findings.length > 0) {
          reads.push({ id: taskFileId(filePath, raw), quarantined: false, findings: read.findings, issues: [] });
        }
        return { ...normalizeTask(read.record), filePath };
      });
    } catch (err) {
      throw new Error(`Task ${id}: push preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/**
 * Write-side scrub for the Research invariant: drop `verified` before a Research
 * task is serialised, so the value never reaches disk.
 *
 * Defence in depth, not the safety net. The read scrub in `normalizeTask` is what
 * makes the value unobservable and is sufficient for correctness; this stops the
 * bad state from existing on disk at all, and from being inherited if the task's
 * type is later changed back to a verifiable one.
 */
function scrubResearchVerified(task: Task): Task {
  if (!isResearchType(task.type) || task.verified === undefined) return task;
  const scrubbed = { ...task };
  delete scrubbed.verified;
  return scrubbed;
}

export function writeTaskJson(projectDir: string, task: Task): void {
  const scrubbed = scrubResearchVerified(task);
  const dateDir = join(
    getTasksDir(projectDir),
    getDateSubdir(scrubbed.created),
  );
  mkdirSync(dateDir, { recursive: true });
  const filePath = join(dateDir, `${scrubbed.id}.json`);
  // Write to a temp file then rename for atomic replacement (prevents torn reads).
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(scrubbed, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

/**
 * Atomic task-file writer that writes to an exact pre-determined path.
 * Used by claimNextTaskAtomic to update the EXACT file that was read,
 * avoiding shadow-file creation when tasks live in the flat legacy layout.
 */
export function writeTaskJsonAt(filePath: string, task: Task): void {
  const tmp = filePath + ".tmp";
  writeFileSync(
    tmp,
    JSON.stringify(scrubResearchVerified(task), null, 2),
    "utf-8",
  );
  renameSync(tmp, filePath);
}

/**
 * Minimal, byte-preserving sortKey writer for maintenance commands.
 *
 * The ordinary write path (`updateTask` → `normalizeTask` → `writeTaskJson`)
 * re-serializes the task through a fixed schema: it DROPS fields it does not
 * know (e.g. the legacy singleton `commit` string), reorders keys, and adds
 * defaulted fields (`verified`). A maintenance backfill must change only
 * `sortKey` (plus bump `updated`), so this edits the raw JSON text in place,
 * preserving every other field and its order, then JSON-validates the result
 * before writing.
 *
 * **Do NOT refactor the reindex command onto `updateTask`.** Doing so silently
 * destroys legacy fields again — it once dropped 18 commit SHAs that existed
 * only in the singular `commit` field.
 *
 * Returns false without writing when the file is missing or the edit would not
 * produce valid JSON.
 */
export function writeSortKeyMinimal(
  projectDir: string,
  taskId: string,
  sortKey: string,
): boolean {
  const filePath = findTaskFilePath(projectDir, taskId);
  if (!filePath) return false;
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  const updatedAt = new Date().toISOString();
  let next = text;

  // Set sortKey in place, or insert it just above `updated` when absent.
  if (/"sortKey"\s*:\s*"[^"]*"/.test(next)) {
    next = next.replace(/"sortKey"\s*:\s*"[^"]*"/, `"sortKey": "${sortKey}"`);
  } else {
    const anchor = /\n(\s*)"updated"\s*:/.exec(next);
    if (!anchor) return false;
    next = next.replace(
      anchor[0],
      `\n${anchor[1]}"sortKey": "${sortKey}",${anchor[0]}`,
    );
  }

  // Bump `updated` (insert when a legacy file has none).
  if (/"updated"\s*:\s*"[^"]*"/.test(next)) {
    next = next.replace(/"updated"\s*:\s*"[^"]*"/, `"updated": "${updatedAt}"`);
  } else {
    if (!/\n\}\s*$/.test(next)) return false;
    next = next.replace(/\n\}\s*$/, `,\n  "updated": "${updatedAt}"\n}`);
  }

  try {
    const parsed = JSON.parse(next) as { id?: string; sortKey?: string };
    if (parsed.id !== taskId || parsed.sortKey !== sortKey) return false;
  } catch {
    return false;
  }

  const tmp = filePath + ".tmp";
  writeFileSync(tmp, next, "utf-8");
  renameSync(tmp, filePath);
  // Invalidate the monotonic ceiling: a backfill re-keys many tasks at once
  // without going through createTask/updateTask, so the cache may now be low.
  // The next create rescans once and re-seeds it.
  invalidateSortKeyCeiling(projectDir);
  return true;
}

// ── CRUD operations ────────────────────────────────────────────────────────

/**
 * Converts literal escape sequences (common when agents or scripts pass text
 * via shell arguments) into their actual character equivalents.  Real newlines,
 * tabs, etc. pass through unchanged so human-created text is never affected.
 * Uses a single-pass regex to correctly preserve `\\n` as a literal backslash + n.
 *
 * Exported so that `comments.ts` (which already imports from this module) can
 * reuse the same logic without circular dependencies.
 */
export function normalizeEscapeSequences(text: string): string {
  return text.replace(/\\(n|t|r|\\)/g, (_, c: string): string => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      default:
        return c;
    }
  });
}

export function createTask(
  projectDir: string,
  input: Omit<Task, "id" | "created" | "comments" | "files">,
): Task {
  const normalizedPriority = (() => {
    const raw = (input.priority ?? "").trim().toLowerCase();
    if (raw === "critical") return "Critical";
    if (raw === "high") return "High";
    if (raw === "low") return "Low";
    return "Medium";
  })();

  // Serialise the scan + write across processes: a CLI `tasks --add` racing
  // the long-lived `serve` process could otherwise read the same max and mint a
  // duplicate pair (which drag normalization does NOT heal — duplicate numeric
  // keys are not a "legacy" state).
  const lock = taskLockPath(projectDir, ".store-create");
  return withFileLockSync(lock, () => {
    // The ceiling is read (and, on a cold store, seeded + cached) inside the
    // same cross-process lock that guards the write, so back-to-back creates
    // from this or another process never mint the same key.
    const ceiling = maxStoreSortKey(projectDir);
    const sortKey = input.sortKey ?? generateSortKeyBetween(ceiling, null);
    const task: Task = {
      ...input,
      title: normalizeEscapeSequences(input.title ?? "").trim(),
      description: normalizeEscapeSequences(input.description ?? "").trim(),
      priority: normalizedPriority,
      // Seed the creator into openedBy: the "new" badge is
      // `!openedBy.includes(currentUserId)` (TaskCard/leading slot), and no
      // create surface — CLI --add, POST /api/tasks, tRPC, MCP — passed it, so
      // a creator always saw their own task as unread. Same identity source as
      // markTaskOpened (server) and window.__VIBEFLOW_USER__ (board), so the
      // id the board compares against is the id seeded here.
      openedBy: input.openedBy ?? [getCurrentUserId()],
      // Every create must mint a key that sorts after everything already in the
      // store, or dragging a newly created task misplaces it. Regression story:
      // commit 3e169ab seeded `generateSortKeyBetween(null, null)` here — a
      // CONSTANT `0000000001000000` — so every create on every surface (board,
      // CLI --add, HTTP, tRPC, MCP) collided on one key (10 tasks by the end of
      // that day). The old comment claimed "the board supplies one on create" —
      // false: DetailPanel sends no sortKey and api.createTask just POSTs, so the
      // board fell through to the constant too.
      //
      // The ceiling comes from the cached sidecar (0.06s scan only on a cold
      // store); `stress.test.ts` proved a per-create full scan is O(n²).
      sortKey,
      id: generateTaskId(),
      created: new Date().toISOString(),
      comments: [],
      files: [],
    };
    writeTaskJson(projectDir, task);
    // Raise (never lower) the ceiling so the next create stays O(1).
    if (!ceiling || sortKey > ceiling) {
      writeSortKeyCeiling(projectDir, sortKey);
    }
    // A created parent edge changes the children map: invalidate under the
    // index lock (ordered against concurrent publishes — see
    // `task-children-index.ts`). Link-free creates skip the index entirely.
    if ((input.links ?? []).some((l) => l?.type === "parent" && l?.taskId)) {
      invalidateChildrenIndexLocked(projectDir);
    }
    return task;
  });
}

/**
 * Value `createTask` must mint ABOVE: the highest key the store is known to
 * need, cached in a sidecar next to the task store so a create stays O(1)
 * instead of rescanning every task file (which was O(n²) in bulk and blew the
 * `stress.test.ts` budget: 5000 creates went from 0.7s to ~115s).
 *
 * The sidecar is a strictly MONOTONIC ceiling: seeded from a full scan when
 * absent or corrupt, raised to every key this module mints or writes, never
 * lowered. Minting `ceiling + gap` therefore always lands above every key we
 * know about, and an over-high ceiling is harmless (it only widens the gap).
 *
 * Whole-store, not per-status: tree sibling groups span statuses, so a
 * per-column ceiling could tie inside a mixed-status sibling group.
 *
 * Out-of-band writes (a `git pull`, a hand-edit) that introduce a higher key
 * WITHOUT going through this module can leave the ceiling low; the failure mode
 * is a possible duplicate key, which `tasks --reindex-sort-keys` heals. Delete
 * `.vibeflow/.sortkey-ceiling` to force a full rescan.
 *
 * Keys are zero-padded fixed-width decimals, so `>` (string comparison) matches
 * numeric order — integers sort before `integer.fraction`, and the fractional
 * segments compare left-to-right.
 */
export function maxStoreSortKey(projectDir: string): string | null {
  const cached = readSortKeyCeiling(projectDir);
  if (cached) return cached;
  const scanned = scanStoreMaxSortKey(projectDir);
  if (scanned) writeSortKeyCeiling(projectDir, scanned);
  return scanned;
}

function sortKeyCeilingPath(projectDir: string): string {
  return join(projectDir, PROTO_DIR, ".sortkey-ceiling");
}

function readSortKeyCeiling(projectDir: string): string | null {
  try {
    const raw = readFileSync(sortKeyCeilingPath(projectDir), "utf-8").trim();
    return /^\d+(\.\d+)?$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeSortKeyCeiling(projectDir: string, key: string): void {
  try {
    const path = sortKeyCeilingPath(projectDir);
    mkdirSync(join(projectDir, PROTO_DIR), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, key, "utf-8");
    renameSync(tmp, path);
  } catch {
    /* a missing ceiling only costs a rescan, never correctness */
  }
}

/**
 * Drop the cache so the next `maxStoreSortKey` rescans the store.
 *
 * Exported for the pull merge (commands/pull.ts): importing a task whose
 * sortKey sits above the cached ceiling would otherwise let the next
 * `createTask()` mint a colliding key. A missing ceiling only costs one
 * rescan, never correctness — so the import invalidates whenever it added
 * a task or changed a sort key, unconditionally.
 */
export function invalidateSortKeyCeiling(projectDir: string): void {
  try {
    unlinkSync(sortKeyCeilingPath(projectDir));
  } catch {
    /* already absent */
  }
}

/** Full scan for the highest well-formed key in the store, or `null` when none. */
function scanStoreMaxSortKey(projectDir: string): string | null {
  let max: string | null = null;
  for (const { task } of collectTaskFiles(projectDir)) {
    const key = task.sortKey;
    if (!key || !/^\d+(\.\d+)?$/.test(key)) continue;
    if (max === null || key > max) max = key;
  }
  return max;
}

function taskFileId(filePath: string, raw?: unknown): string {
  if (raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string") return raw.id;
  return filePath.slice(filePath.lastIndexOf("/") + 1, -5);
}

/** Never throws or writes. Quarantine has no record and cannot enter a merge. */
export function readTaskRecordFile(filePath: string): LocalTaskRecordRead & { id: string } {
  try {
    if (!isTaskJsonFile(filePath)) throw new Error("Not a task JSON file");
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return { ...inspectLocalTaskRecord(raw), id: taskFileId(filePath, raw) };
  } catch {
    return { id: taskFileId(filePath), record: null, canonical: null, findings: [], issues: [{ path: "", code: "unreadable_json", message: "Task file is unreadable or invalid JSON" }] };
  }
}

/** Compatibility display API; validation happens BEFORE display defaults. */
export function readTaskFile(filePath: string): Task | null {
  const read = readTaskRecordFile(filePath);
  return read.record ? normalizeTask(read.record) : null;
}

function collectTaskFiles(projectDir: string, reads?: TaskReadFinding[]): Array<{ task: Task; filePath: string }> {
  const results: Array<{ task: Task; filePath: string }> = [];
  for (const { filePath } of listTaskRawFiles(projectDir)) {
    const read = readTaskRecordFile(filePath);
    if (!read.record || read.findings.length > 0) {
      reads?.push({ id: read.id, quarantined: !read.record, findings: read.findings, issues: read.issues });
    }
    if (read.record) results.push({ task: normalizeTask(read.record), filePath });
  }
  return results;
}

export function listTasks(projectDir: string, reads?: TaskReadFinding[]): Task[] {
  return collectTaskFiles(projectDir, reads).map(({ task }) => task);
}

export function listTasksWithPaths(projectDir: string, reads?: TaskReadFinding[]): Array<Task & { filePath: string }> {
  return collectTaskFiles(projectDir, reads).map(({ task, filePath }) => ({ ...task, filePath }));
}

/** Parent edges of the whole store, for the children-index scanner. */
function scanChildEdges(projectDir: string): ChildEdge[] {
  const edges: ChildEdge[] = [];
  for (const t of listTasksWithPaths(projectDir)) {
    for (const l of t.links ?? []) {
      if (l?.type === "parent" && l?.taskId) {
        edges.push({ id: t.id, parentId: l.taskId });
      }
    }
  }
  return edges;
}

export function updateTask(
  projectDir: string,
  taskId: string,
  updates: Partial<Omit<Task, "id" | "created">>,
): Task | null {
  // Wrap the read-modify-write in a cross-process write lock to prevent
  // lost updates from concurrent callers (e.g. two HTTP requests).
  const lock = taskLockPath(projectDir, taskId);
  // NOTE: withTaskLock is async but updateTask is sync — run the lock
  // via a synchronous spin-wait for backward compatibility.
  // For callers that can be async, prefer the async version below.
  let result: Task | null = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      openSync(lock, "wx");
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > 10_000) {
          try {
            unlinkSync(lock);
          } catch {
            /* ignore */
          }
          continue;
        }
      } catch {
        continue;
      }
      const spinStart = Date.now();
      while (Date.now() - spinStart < 10 && Date.now() < deadline) {
        /* spin */
      }
    }
  }
  try {
    const existingPath = findTaskFilePath(projectDir, taskId);
    const task = existingPath ? readTaskFile(existingPath) : null;
    if (!task) return null;
    const now = new Date().toISOString();
    const updated: Task = scrubResearchVerified({
      ...task,
      ...updates,
      updated: now,
    });
    // Owner rule: a parent marked done marks all descendants done.
    // The descendant SET comes from the parent→children sidecar index
    // (O(1); rebuilt from one full scan when missing/stale/corrupt — see
    // `task-children-index.ts`), never from a per-edit board scan: scanning
    // here turned 500 done-edits on a 5k-task store from <10s into ~140s.
    // The edge map is walked with the canonical `getDescendants` (cycle-
    // safe) over minimal reconstructed rows — no second walker. Forward-
    // only (a child done never touches its parent); already-done
    // descendants are left byte-untouched (no `updated` bump), so the
    // cascade is idempotent.
    const cascaded: Array<{ filePath: string; record: Task }> = [];
    let cascadeIndex: TaskChildrenIndex | null = null;
    if (updated.status === "done") {
      cascadeIndex = loadFreshChildrenIndex(projectDir, () =>
        scanChildEdges(projectDir),
      );
      // Minimal rows for the canonical walker: id + parent edges only.
      // A child with several parent links (hand-forged stores) keeps them
      // all, exactly as a board snapshot would present them.
      const parentsByChild = new Map<string, Set<string>>();
      for (const [parentId, childIds] of Object.entries(
        cascadeIndex.parents,
      )) {
        for (const childId of childIds) {
          let set = parentsByChild.get(childId);
          if (!set) {
            set = new Set<string>();
            parentsByChild.set(childId, set);
          }
          set.add(parentId);
        }
      }
      // SAFETY: `getDescendants` reads only `id` and `links`; the remaining
      // Task fields are never touched by the walk, so narrowed rows are
      // exact for this call (same as passing full records).
      const walkerRows = [...parentsByChild.entries()].map(([id, ps]) => ({
        id,
        links: [...ps].map((linkParentId) => ({
          taskId: linkParentId,
          type: "parent" as const,
        })),
      })) as unknown as Task[];
      const ids = getDescendants(walkerRows, taskId).filter(
        (id) => id !== taskId,
      );
      for (const id of ids) {
        const childPath = findTaskFilePath(projectDir, id);
        const child = childPath ? readTaskFile(childPath) : null;
        // Missing (deleted mid-flight) or already done: skip without
        // writing, so the cascade never fails the parent edit and never
        // bumps `updated` on tasks that already converged.
        if (!child || !childPath || child.status === "done") continue;
        cascaded.push({
          filePath: childPath,
          record: scrubResearchVerified({
            ...child,
            status: "done",
            updated: now,
          }),
        });
      }
    }
    writeTaskJson(projectDir, updated);
    // Same record writer as a normal edit (temp/rename per file, so no torn
    // reads); every record was prepared before the first write, so a failure
    // cannot leave a half-computed set behind.
    for (const { filePath, record } of cascaded) {
      writeTaskJsonAt(filePath, record);
    }
    // Index bookkeeping, LAST (record writes already landed): a link edit
    // in this call invalidates (deleted, never patched — the next cascade
    // rebuilds once); a pure status cascade only re-stamps (map unchanged).
    // `"links" in updates` — not a value check: clearing every link writes
    // `links: undefined`, which still changes edges. Non-done, non-link
    // edits skip the index entirely (claims stay on the zero-I/O path).
    // Best-effort throughout: a missed write only costs a rebuild, because
    // every record write above already bumped the generation stamp.
    if ("links" in updates) {
      invalidateChildrenIndexLocked(projectDir);
    } else if (cascadeIndex) {
      refreshChildrenIndex(
        projectDir,
        () => scanChildEdges(projectDir),
        cascadeIndex,
      );
    }
    // Keep the monotonic sortKey ceiling above any key an update writes (a drag
    // appended to the bottom raises the store max). Read through
    // `maxStoreSortKey`, not the raw cache: when the sidecar is missing — e.g.
    // `--reindex-sort-keys` deleted it after re-keying the store — this rescans
    // for the TRUE store max instead of seeding the ceiling from this single
    // updated task's key. Seeding from that key would let the next `--add` mint
    // `thatKey + gap`, landing it mid-store when the updated task does not sort
    // last. Done under the same lock creates use, because the ceiling is a
    // read-modify-write; best-effort so a lock timeout can never fail the update.
    if (updated.sortKey) {
      try {
        const current = maxStoreSortKey(projectDir);
        if (!current || updated.sortKey > current) {
          withFileLockSync(taskLockPath(projectDir, ".store-create"), () => {
            const latest = maxStoreSortKey(projectDir);
            if (!latest || (updated.sortKey as string) > latest) {
              writeSortKeyCeiling(projectDir, updated.sortKey as string);
            }
          });
        }
      } catch {
        /* a stale ceiling only costs a rescan, never correctness */
      }
    }
    // If the task moved from flat layout to date-based, remove the old flat file
    if (
      existingPath &&
      existingPath !== getTaskFilePath(projectDir, taskId, updated.created)
    ) {
      try {
        unlinkSync(existingPath);
      } catch {
        /* ignore */
      }
    }
    result = updated;
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* best-effort cleanup */
    }
  }
  return result;
}

export function deleteTask(projectDir: string, taskId: string): boolean {
  const filePath = findTaskFilePath(projectDir, taskId);
  if (!filePath) return false;
  unlinkSync(filePath);
  // Node removal: stale entries for the deleted task can only produce
  // skippable-missing lookups (never a wrong cascade), and the mtime bump
  // forces a rebuild anyway — but invalidate under lock regardless, so the
  // rule stays absolute: every edge-affecting writer invalidates.
  invalidateChildrenIndexLocked(projectDir);
  return true;
}

/**
 * Return all descendant ids (children, grandchildren, …) of a task by
 * following `parent` links. Cycle-safe via visited-set; parents always
 * appear before their children, so reversing the result yields
 * deepest-first order for recursive deletion.
 */
export function getDescendantIds(allTasks: Task[], taskId: string): string[] {
  const result: string[] = [];
  const visited = new Set<string>([taskId]);
  const queue = [taskId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const t of allTasks) {
      if (
        t?.id &&
        !visited.has(t.id) &&
        t.links?.some((l) => l?.type === "parent" && l?.taskId === id)
      ) {
        visited.add(t.id);
        result.push(t.id);
        queue.push(t.id);
      }
    }
  }
  return result;
}

/**
 * Detach a task from its parent without deleting the task itself.
 *
 * - Removes the parent link from the task's links.
 * - When deleteChildren is false (default): re-parents the task's direct
 *   children to the task's former parent so the subtree stays connected.
 * - When deleteChildren is true: deletes all descendants (descendants only;
 *   the task itself survives as a root task).
 *
 * Returns the updated task, or null if the task was not found.
 */
export function detachParent(projectDir: string, taskId: string): Task | null {
  const allTasks = listTasks(projectDir);
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) return null;

  // Find the parent link
  const parentLink = (task.links ?? []).find(
    (l) => l?.type === "parent" && l?.taskId,
  );
  const formerParentId = parentLink?.taskId ?? null;

  // Remove the parent link from this task
  const newLinks = (task.links ?? []).filter(
    (l) => !(l?.type === "parent" && l?.taskId === formerParentId),
  );
  updateTask(projectDir, taskId, { links: newLinks });

  if (formerParentId) {
    // Re-parent direct children to the former parent
    const children = allTasks.filter(
      (t) =>
        t?.id &&
        t.links?.some((l) => l?.type === "parent" && l?.taskId === taskId),
    );
    for (const child of children) {
      if (!child.id) continue;
      const childNewLinks = (child.links ?? []).map((l) =>
        l?.type === "parent" && l?.taskId === taskId
          ? { ...l, taskId: formerParentId }
          : l,
      );
      updateTask(projectDir, child.id, { links: childNewLinks });
    }
  }

  // Return the updated task (parent link removed)
  const updatedPath = findTaskFilePath(projectDir, taskId);
  return updatedPath ? readTaskFile(updatedPath) : null;
}

// ── Atomic task claiming ──────────────────────────────────────────────────

/**
 * Atomically claim the next todo task (highest priority, oldest created).
 *
 * Runs inside a GLOBAL claim lock (one claim at a time across processes) so
 * candidate selection is serialized. Each candidate is re-read inside the
 * lock to guard against a concurrent writer that already claimed it.
 *
 * Returns the claimed Task, or null when nothing is claimable.
 *
 * **Re-entrancy contract:** This function uses `withTaskLock` internally;
 * callers must not call `withTaskLock` on the same lockPath from within `fn`.
 */
/**
 * The id of a task's parent, if it has a parent link. A `parent` link whose
 * target is missing from the store still counts: the task is parented, so the
 * board renders it inside a tree rather than as its own card.
 */
export function getParentId(task: Task): string | undefined {
  const link = (task.links ?? []).find((l) => l.type === "parent");
  return link?.taskId;
}

/**
 * Whether a task belongs to a tree rather than standing on its own.
 *
 * A task is a CHILD when it carries a `parent` link. Whether that parent still
 * exists is deliberately not consulted: the board groups a parented task under
 * its root, so a dangling link would otherwise make the task invisible in both
 * places — not a root (it has a link) and not a child row (no parent to nest
 * it under). Treating it as a child keeps the two surfaces agreeing and leaves
 * it reachable via `--get`, which is never filtered.
 */
export function isChildTask(task: Task): boolean {
  return getParentId(task) !== undefined;
}

/** Direct children of `parentId`, in the store's natural order. */
export function getChildTasks(allTasks: Task[], parentId: string): Task[] {
  return allTasks.filter((t) => getParentId(t) === parentId);
}

/**
 * A task's children with the minimum an agent needs to judge what remains:
 * id, title, status. Kept deliberately narrow so `--next` can inline the whole
 * unit of work without dumping every child's description into the result.
 */
export interface ChildSummary {
  id: string;
  title: string;
  status: TaskStatus;
  priority?: string;
}

export function summariseChildren(
  allTasks: Task[],
  parentId: string,
): ChildSummary[] {
  return getChildTasks(allTasks, parentId).map((c) => ({
    id: c.id,
    title: c.title,
    status: c.status,
    ...(c.priority ? { priority: c.priority } : {}),
  }));
}

/**
 * A task's UNSATISFIED blockers: `blocks` links whose target is anything but
 * `done`. `review` counts as unfinished — agents never set `done`, so a gate
 * sitting in review has not passed. A dangling target (missing from the store)
 * is ignored: it names nothing `--next` could report, and must not wedge the
 * queue forever.
 */
export function getUnfinishedBlockers(
  task: Task,
  allTasks: Task[],
): Task[] {
  const blockedByIds = (task.links ?? [])
    .filter((l) => l.type === "blocks")
    .map((l) => l.taskId);
  if (blockedByIds.length === 0) return [];
  const byId = new Map(allTasks.map((t) => [t.id, t] as const));
  return blockedByIds.flatMap((id) => {
    const found = byId.get(id);
    return found && found.status !== "done" ? [found] : [];
  });
}

/** True when `task` has at least one `blocks` link pointing at unfinished work. */
export function isBlockedByUnfinishedWork(
  task: Task,
  allTasks: Task[],
): boolean {
  return getUnfinishedBlockers(task, allTasks).length > 0;
}

/**
 * Statuses in which a parent keeps its children claimable.
 *
 * Owner rule (ticket 4ab7104a): `--next`'s child fallback may only hand out
 * a todo child that belongs to live work. A child of a backlog/done parent
 * is a fragment of a parked or finished unit — claiming it slices work off
 * a unit nobody opened. `review` counts as active: the unit is under
 * verification, its remaining children are still live work.
 */
export const ACTIVE_CLAIM_PARENT_STATUSES = [
  "todo",
  "in-progress",
  "review",
] as const;

/**
 * True when every ancestor of `task` exists and holds an active status
 * (todo/in-progress/review). A root has no ancestors, so it is always
 * active. A dangling parent link (target missing from the store) is
 * INACTIVE: the chain cannot be verified, so the child is not claimable
 * through the fallback — it stays reachable via `--get`, never invisible.
 */
export function isParentChainActive(
  allTasks: Task[],
  task: Task,
): boolean {
  const byId = new Map(allTasks.map((t) => [t.id, t] as const));
  const seen = new Set<string>([task.id]);
  let current: Task | undefined = task;
  for (;;) {
    const parentId = current ? getParentId(current) : undefined;
    if (!parentId) return true;
    if (seen.has(parentId)) return false; // cycle — never claimable
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return false; // dangling link — chain unverifiable
    if (
      !(ACTIVE_CLAIM_PARENT_STATUSES as readonly string[]).includes(
        parent.status,
      )
    )
      return false;
    current = parent;
  }
}

/**
 * Export signature for the claim primitive.
 */
export function claimNextTaskAtomic(
  projectDir: string,
  opts: {
    type?: string;
    user?: string;
    tag?: string[];
    author?: string;
    /**
     * Only consider ROOT tasks — never a task that has a parent. The owner's
     * decision for `--next`: an agent is given the root unit of work, and the
     * root carries its children, rather than being handed a fragment of one.
     */
    rootsOnly?: boolean;
    /**
     * Allow claiming a todo child whose parent chain is NOT fully active
     * (backlog/done parent, or a dangling link). Default false (owner rule,
     * ticket 4ab7104a): the fallback only hands out children of live work.
     * Opt in only when the caller reports the slice explicitly.
     */
    allowInactiveParentChain?: boolean;
  } = {},
): Task | null {
  const lock = taskLockPath(projectDir, "claim");
  let result: Task | null = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      openSync(lock, "wx");
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > 10_000) {
          try {
            unlinkSync(lock);
          } catch {
            /* ignore */
          }
          continue;
        }
      } catch {
        continue;
      }
      const spinStart = Date.now();
      while (Date.now() - spinStart < 10 && Date.now() < deadline) {
        /* spin */
      }
    }
  }
  try {
    // 1. Snapshot all tasks on disk (inside the claim lock, so the blocker
    //    statuses the selector reads are current).
    const candidates = listTasksWithPaths(projectDir);
    // 2-4. Select through the ONE shared eligibility selector (roots first,
    //    then live-children fallback, unfinished blockers suppressed — see
    //    `core/claim-eligibility.ts`), then re-read the pick inside the lock
    //    to verify it is still 'todo' (a concurrent writer may have claimed
    //    it) before writing. Only `done` satisfies a `blocks` link —
    //    `review` is NOT done.
    const selection = selectClaimCandidate(candidates, opts);
    const candidate = selection?.task;
    if (candidate) {
      const reRead = readTaskFile(candidate.filePath);
      // The selector already excluded blocked candidates against this same
      // snapshot, so a re-read that is still todo is claimable — no second
      // policy check here that could drift from the selector.
      if (reRead && reRead.status === "todo") {
        // 5. Write the claimed task — set author ONLY when defined (never
        //    author: undefined which would overwrite through the spread).
        const now = new Date().toISOString();
        const updates: Partial<Task> = {
          status: "in-progress" as TaskStatus,
          updated: now,
        };
        if (opts.author) {
          updates.author = opts.author;
        }
        const claimedTask: Task = { ...reRead, ...updates };
        writeTaskJsonAt(candidate.filePath, claimedTask);
        result = claimedTask;
      }
    }
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* best-effort cleanup */
    }
  }
  return result;
}

/**
 * Returns only the fields relevant to a coding agent for a single task.
 *
 * Use this function inside the `tasks` CLI command output and anywhere else
 * that coding agents consume task data (e.g. export prompts, MCP tools).
 * Deliberately excludes: cssSelector (redundant), updated/removed timestamps
 * (noise).
 */
export interface AgentTask {
  id: string;
  status: string;
  title: string;
  description: string;
  url?: string;
  selector: string;
  file?: string;
  line?: number;
  col?: number;
  component?: string;
  type?: string;
  priority?: string;
  /** Structured threaded comments embedded in the task JSON. */
  structuredComments?: TaskComment[];
  /** Files attached to this task (linked via the UI or API). */
  linkedFiles?: FileInfo[];
  /** When true, add a comment with your implementation report after completing this task. */
  reportBack?: boolean;
  created: string;
}

export function formatTaskForAgent(
  task: Task,
  comments?: TaskComment[],
  files?: FileInfo[],
): AgentTask {
  return {
    id: task.id,
    status: task.status,
    title: task.title,
    description: task.description,
    ...(task.url && { url: task.url }),
    selector: task.selector,
    ...(task.file && { file: task.file }),
    ...(task.line != null && { line: task.line }),
    ...(task.col != null && { col: task.col }),
    ...(task.component && { component: task.component }),
    ...(task.type && { type: task.type }),
    ...(task.priority && { priority: task.priority }),
    ...(comments && comments.length > 0 && { structuredComments: comments }),
    ...(files && files.length > 0 && { linkedFiles: files }),
    ...(task.reportBack && { reportBack: true }),
    created: task.created,
  };
}

/**
 * Marks a task as opened by a user. Adds the userId to the openedBy array
 * if not already present. Persists to the task JSON file.
 */
export function markTaskOpened(
  projectDir: string,
  taskId: string,
  userId: string,
): void {
  const filePath = findTaskFilePath(projectDir, taskId);
  if (!filePath) return;
  const task = readTaskFile(filePath);
  if (!task) return;
  if (!task.openedBy) task.openedBy = [];
  if (!task.openedBy.includes(userId)) {
    task.openedBy.push(userId);
    writeFileSync(filePath, JSON.stringify(task, null, 2) + "\n");
  }
}

/** Stable id for per-user task state (openedBy / expandedBy). */
export function getCurrentUserId(): string {
  return process.env.USER ?? process.env.USERNAME ?? "agent";
}

/**
 * Persists a user's card expand/collapse choice. Expanding adds the userId to
 * expandedBy; collapsing removes it. Returns the updated task, or null when
 * the task does not exist. Unchanged state is not rewritten.
 */
export function setTaskExpanded(
  projectDir: string,
  taskId: string,
  userId: string,
  expanded: boolean,
): Task | null {
  const filePath = findTaskFilePath(projectDir, taskId);
  if (!filePath) return null;
  const task = readTaskFile(filePath);
  if (!task) return null;
  const current = task.expandedBy ?? [];
  if (current.includes(userId) === expanded) return task;
  task.expandedBy = expanded
    ? [...current, userId]
    : current.filter((id) => id !== userId);
  writeFileSync(filePath, JSON.stringify(task, null, 2) + "\n");
  return task;
}

/**
 * Renders a task, its comments, and linked files into the exact plain-text
 * format produced by `vibeflow tasks --get`. This is shared between the CLI
 * `--get` command and any agent-facing rendering (e.g. `--next`) so agents
 * always receive identical instructions.
 */
export function renderTaskForAgent(
  task: Task,
  taskFilePath: string,
  comments: TaskComment[],
  files: FileInfo[],
  projectDir: string,
  allTasks?: Task[],
): string {
  const lines: string[] = [];

  // Stryker disable once StringLiteral: display format for task rendering
  lines.push(`[${task.status}] ${task.title}`);
  // Stryker disable once StringLiteral: display format for task rendering
  lines.push(`    id:       ${task.id}`);
  // Stryker disable once StringLiteral: display format for task rendering
  lines.push(`    file:     ${taskFilePath}`);
  if (task.file) {
    // Stryker disable once StringLiteral: display format for task rendering
    lines.push(
      `    source:   ${task.file}${task.line == null ? "" : `:${task.line}`}${task.col == null ? "" : `:${task.col}`}`,
    );
  }
  if (task.component) lines.push(`    component: ${task.component}`);
  // Stryker disable once StringLiteral: display format for task rendering
  lines.push(`    selector: ${task.selector ?? "/"}`);
  if (task.cssSelector) lines.push(`    css:      ${task.cssSelector}`);
  if (task.url) lines.push(`    url:      ${task.url}`);
  if (task.commits && task.commits.length > 0) {
    if (task.commits.length === 1) {
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`    commit:   ${task.commits[0].sha}`);
    } else {
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`    commits (${task.commits.length}):`);
      for (const c of task.commits) {
        // Stryker disable once StringLiteral: display format for task rendering
        lines.push(
          `      ${c.sha.slice(0, 8)}  ${c.timestamp}  ${c.message.slice(0, 60)}`,
        );
      }
    }
  }
  // Stryker disable once StringLiteral: display format for task rendering
  lines.push(`    created:  ${task.created}`);
  if (task.type) lines.push(`    type:     ${task.type}`);
  if (task.priority) lines.push(`    priority: ${task.priority}`);
  if (task.author) lines.push(`    author:   ${task.author}`);
  if (task.description) {
    // Stryker disable once StringLiteral: display format for task rendering
    lines.push(`    description:`);
    for (const line of task.description.split("\n"))
      lines.push(`      ${line}`);
  }
  if (task.annotatedElementText) {
    // Stryker disable once StringLiteral: display format for task rendering
    lines.push(`    element text: ${task.annotatedElementText}`);
  }
  if (comments.length > 0) {
    // Stryker disable once StringLiteral: display format for task rendering
    lines.push(`    comments (${comments.length}):`);
    for (const c of comments) {
      const edited = c.updatedAt ? ` (edited ${c.updatedAt})` : "";
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`      [${c.author ?? "user"}] ${c.createdAt}${edited}`);
      for (const line of c.text.split("\n")) lines.push(`        ${line}`);
    }
  }
  if (files.length > 0) {
    // Stryker disable once StringLiteral: display format for task rendering
    lines.push(`    linked files (${files.length}):`);
    for (const f of files) {
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`      - ${f.name}  ${f.url}`);
      const absPath =
        f.linkedPath ?? join(projectDir, ".vibeflow", "files", task.id, f.name);
      if (
        /\.(md|txt)$/i.test(f.name) &&
        f.size < 100_000 &&
        existsSync(absPath)
      ) {
        try {
          const content = readFileSync(absPath, "utf-8");
          // Stryker disable once StringLiteral: display format for task rendering
          lines.push(`        ┌── content ──`);
          for (const line of content.split("\n"))
            lines.push(`        │  ${line}`);
          // Stryker disable once StringLiteral: display format for task rendering
          lines.push(`        └─────────────`);
        } catch {
          /* file read failed – show URL only */
        }
      }
    }
  }

  // ── Relationships (children, related, blocked) ──────────────────────
  if (allTasks && allTasks.length > 0) {
    const taskLinks = task.links ?? [];

    // Children: tasks whose parent link points at this task
    const children = allTasks.filter((t) =>
      (t.links ?? []).some((l) => l.type === "parent" && l.taskId === task.id),
    );
    if (children.length > 0) {
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`    children (${children.length}):`);
      for (const c of children) {
        // Stryker disable once StringLiteral: display format for task rendering
        lines.push(`      [${c.status}] ${c.title}  ${c.id.slice(0, 12)}`);
      }
    }

    // Related: tasks linked via 'relates' type
    const relatedIds = taskLinks
      .filter((l) => l.type === "relates")
      .map((l) => l.taskId);
    const related = relatedIds.flatMap((id) => {
      const found = allTasks.find((t) => t.id === id);
      return found ? [found] : [];
    });
    if (related.length > 0) {
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`    related (${related.length}):`);
      for (const r of related) {
        // Stryker disable once StringLiteral: display format for task rendering
        lines.push(`      [${r.status}] ${r.title}  ${r.id.slice(0, 12)}`);
      }
    }

    // Blocked by: tasks linked via 'blocks' type (this task is blocked by them)
    const blockedByIds = taskLinks
      .filter((l) => l.type === "blocks")
      .map((l) => l.taskId);
    const blockedBy = blockedByIds.flatMap((id) => {
      const found = allTasks.find((t) => t.id === id);
      return found ? [found] : [];
    });
    if (blockedBy.length > 0) {
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`    blocked by (${blockedBy.length}):`);
      for (const b of blockedBy) {
        // Stryker disable once StringLiteral: display format for task rendering
        lines.push(`      [${b.status}] ${b.title}  ${b.id.slice(0, 12)}`);
      }
    }

    // Blocking: tasks that are blocked by this task
    const blocking = allTasks.filter((t) =>
      (t.links ?? []).some((l) => l.type === "blocks" && l.taskId === task.id),
    );
    if (blocking.length > 0) {
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`    blocking (${blocking.length}):`);
      for (const bl of blocking) {
        // Stryker disable once StringLiteral: display format for task rendering
        lines.push(`      [${bl.status}] ${bl.title}  ${bl.id.slice(0, 12)}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Renders agent workflow instructions as plain text (no ANSI colors).
 * This is the text counterpart to the console-formatted instructions shown
 * by `vibeflow tasks --get`, and is appended to the agent prompt so the
 * LLM knows the project workflow, settings, and constraints.
 */
export function renderAgentInstructions(opts: {
  hasResearchTasks: boolean;
  hasBugTasks?: boolean;
  autoCommit?: boolean;
  autoPush?: boolean;
  autoComment?: boolean;
  createBranch?: boolean;
  requireVerifyBeforeReview?: boolean;
}): string {
  const { autoCommit, autoPush, autoComment, createBranch } = opts;
  const lines: string[] = [];

  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("Agent instructions (concise):");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "  Discover: vibeflow tasks --status todo   |  vibeflow tasks --type Research   |  vibeflow tasks --user <email>  |  vibeflow tasks --tag <tag>",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "            Lists ROOT tasks by default (a child belongs to its parent — pass --children to include them); a filtered query (--status/--type/--tag/--user) always returns EVERY matching task, children included, with parent context.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "  Auto-claim: vibeflow tasks --next  (picks the highest-priority todo task — a ROOT first; when no todo root is claimable it claims the highest-priority matching todo child of live work (parent chain todo/in-progress/review) and says so explicitly, refusing children of backlog/done parents loudly instead of slicing them off. It lists the claimed root's children with their statuses.)",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "  Details:  vibeflow tasks --get <id>  (full task info with comments and files; append --json for machine-readable output)",
  );
  // Self-documenting tool use: agents without loaded skills must still mine
  // verify evidence with the explorer sub-commands (not by hand-parsing the
  // evidence JSON). The sub-commands read STATIC captured evidence only —
  // hover/focus/behavior still needs a live check.
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "            Evidence: BEFORE hand-parsing verify evidence JSON, explore it with vibeflow verify style_query | style_diff | element_info | html_diff <id> (STATIC capture only).",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    '  Create:   vibeflow tasks --add --title "..." --description "..."',
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  Workflow:");
  if (createBranch) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    ⚠ Create a branch FIRST, before any implementation:");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    1. git checkout -b <short-name>  (e.g. fix/annotation-errors, feat/eye-toggle, chore/cleanup-extension)",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "       Branch name rules: lowercase, kebab-case, 2-5 words, prefix fix/feat/chore/docs.",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "       Describe the WORK done (not dates). Bad: agent/2026-04-16. Good: fix/bug-errors-visibility.",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    2. vibeflow tasks --edit <id> --set-status in-progress  ← CLAIM TASK",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    3. <implement the change>");
  } else {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    ⚠ IMMEDIATELY set in-progress BEFORE any implementation work:",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    1. vibeflow tasks --edit <id> --set-status in-progress  ← DO THIS FIRST",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "       (if you used --next: task is already in-progress — skip to step 2)",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    2. <implement the change>");
  }
  // When requireVerifyBeforeReview is ON, verify comes BEFORE review.
  // When OFF, verify comes after review (optional step).
  const verifyBeforeReview = opts.requireVerifyBeforeReview;
  // Shared verify-step wording, used by every branch that lists verify. It must
  // state all three facts: verify only gathers evidence; it does not set a
  // verdict and cannot judge correctness; the agent must attest itself with
  // --set-verify and the review gate requires that verdict. It must also tell
  // the agent to ALWAYS attempt verification (annotated or not), and to record
  // --set-verify cannot --verify-reason "<why>" when a task genuinely cannot be
  // verified here.
  const verifyEvidenceLines: string[] = [];
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       ALWAYS attempt verification — even with no baseline and no ground truth. Verify what you CAN:",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       does the artifact actually satisfy what this ticket asked?",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       Annotated UI task (URL + selector): run 'vibeflow verify <id>' AND reason about the result.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       verify only checks that your annotated element still resolves and that the page logged",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       no NEW console errors. It CANNOT tell whether you did what the ticket asked — YOU judge that.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       Counterexamples that PASS verify but are still WRONG: making a button green when the ticket",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       said red, or fixing a different bug than the ticket describes.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       Non-UI task (docs, rename, copy, links, config): no automated check exists — inspect the artifact",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       yourself, e.g. rename → grep the old string and assert ZERO occurrences; links → resolve every",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       href and assert none 404; README → confirm every referenced file exists and is actually shipped",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       in the package's files list; command reference → confirm each documented command exists in --help.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       Did you actually accomplish the task? If not, set it back to in-progress and fix it.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       If the task genuinely CANNOT be verified here, declare it so no badge shows:",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    '         vibeflow tasks --edit <id> --set-verify cannot --verify-reason "<why>"',
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       (cannot records no verdict or badge — the honest state for an unverifiable task; the reason",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push(
    "       is recorded in the task's activity. --set-verify fail means you verified it is WRONG.)",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyEvidenceLines.push("       Never submit work you know is incomplete.");
  const verifyAttestationLines: string[] = [];
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyAttestationLines.push(
    "       --set-verify pass is YOUR attestation that the task IS implemented correctly. The review gate",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyAttestationLines.push(
    "       requires a verdict on annotated (URL + selector) tasks. If you verified and the task is",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  verifyAttestationLines.push(
    "       WRONG, record --set-verify fail — that does NOT pass the gate; fix the work first.",
  );
  if (verifyBeforeReview) {
    // Verify gate ON: verify → review
    if (autoCommit) {
      // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
      lines.push(
        createBranch
          ? "    4. git add <files>   (stage your changes first)"
          : "    3. git add <files>   (stage your changes first)",
      );
      // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
      lines.push(
        `    ${createBranch ? "5" : "4"}. vibeflow verify <id>   (collect the EVIDENCE — it does NOT set the 'verified' flag)`,
      );
      lines.push(...verifyEvidenceLines);
      const reviewArgs = ["--set-status review", "--set-verify pass"];
      if (autoCommit) reviewArgs.push('--commit-message "<one-line summary>"');
      if (autoComment) reviewArgs.push('--comment "<report>"');
      lines.push(
        `    ${createBranch ? "6" : "5"}. vibeflow tasks --edit <id> ${reviewArgs.join(" ")}`,
      );
      lines.push(...verifyAttestationLines);
      // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
      lines.push(
        "       CLI will commit staged changes and link the commit SHA automatically.",
      );
    } else {
      // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
      lines.push(
        createBranch
          ? '    4. git add <files> && vibeflow tasks --commit --task <id> --message "<one-line summary>" -- <files>'
          : '    3. git add <files> && vibeflow tasks --commit --task <id> --message "<one-line summary>" -- <files>',
      );
      // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
      lines.push(
        `    ${createBranch ? "5" : "4"}. vibeflow verify <id>   (collect the EVIDENCE — it does NOT set the 'verified' flag)`,
      );
      lines.push(...verifyEvidenceLines);
      const reviewArgs = ["--set-status review", "--set-verify pass"];
      if (autoComment) reviewArgs.push('--comment "<report>"');
      lines.push(
        `    ${createBranch ? "6" : "5"}. vibeflow tasks --edit <id> ${reviewArgs.join(" ")}`,
      );
      lines.push(...verifyAttestationLines);
    }
  } else {
    // Verify gate OFF: review → verify (optional)
    if (autoCommit) {
      // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
      lines.push(
        createBranch
          ? "    4. git add <files>   (stage your changes first)"
          : "    3. git add <files>   (stage your changes first)",
      );
      const reviewArgs = ["--set-status review"];
      if (autoCommit) reviewArgs.push('--commit-message "<one-line summary>"');
      if (autoComment) reviewArgs.push('--comment "<report>"');
      lines.push(
        `    ${createBranch ? "5" : "4"}. vibeflow tasks --edit <id> ${reviewArgs.join(" ")}`,
      );
      // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
      lines.push(
        "       CLI will commit staged changes and link the commit SHA automatically.",
      );
    } else {
      // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
      lines.push(
        createBranch
          ? '    4. git add <files> && vibeflow tasks --commit --task <id> --message "<one-line summary>" -- <files>'
          : '    3. git add <files> && vibeflow tasks --commit --task <id> --message "<one-line summary>" -- <files>',
      );
      const reviewArgs = ["--set-status review"];
      if (autoComment) reviewArgs.push('--comment "<report>"');
      lines.push(
        `    ${createBranch ? "5" : "4"}. vibeflow tasks --edit <id> ${reviewArgs.join(" ")}`,
      );
    }
    const verifyStep = createBranch ? "6" : "5";
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      `    ${verifyStep}. vibeflow verify <id>  (optional here — collect the EVIDENCE; it does NOT set the 'verified' flag)`,
    );
    lines.push(...verifyEvidenceLines);
  }
  if (autoComment) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("  Comment format (--comment):");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Plain text for concise one-liners.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    · Markdown for multi-section reports. Use **bold**, bullet lists, code fences.",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    · Must cover: what changed, why, key decisions, anything future agents should know.",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    · For long reports, attach a .md file and reference it in the comment.",
    );
  }
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("");

  if (autoCommit) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "  [setting] Auto-commit ON: provide --commit-message when setting status to review; CLI commits.",
    );
  }
  if (autoPush) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "  [setting] Auto-push ON: CLI pushes after the commit automatically.",
    );
  }
  if (autoComment) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "  [setting] Auto-comment ON: --comment is required when setting status to review.",
    );
  }
  if (createBranch) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "  [setting] Create branch ON: all work goes on a dedicated branch created before implementation.",
    );
  }
  if (opts.requireVerifyBeforeReview) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "  [setting] Verify gate ON: tasks WITH a URL + selector need your --set-verify pass verdict at review (or --set-verify cannot --verify-reason \"<why>\").",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    --set-verify is YOUR judgement: pass = implemented correctly, fail = NOT correct, cannot = unverifiable here.",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    vibeflow verify only gathers evidence (element resolves + no new console errors) and cannot make that call.",
    );
  }
  if (opts.hasResearchTasks) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("  Research tasks: NEVER generate code — research only.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    Attach a .md report before marking Research tasks as review.",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    CLI ENFORCES: cannot mark Research as review without an attached .md report.",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    Create the report file locally first, then upload when marking as review:",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      '      vibeflow tasks --edit <id> --set-status review --report-file ./report.md --comment "..."',
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    The file is saved next to the task and deleted from the original path automatically.",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    Report must include: findings, options considered (with pros/cons), recommendation, sources.",
    );
  }
  if (opts.hasBugTasks) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "  Bug tasks: Reproduce the bug first, then include in the comment:",
    );
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Symptom: what the user sees");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Trigger: exact steps to reproduce");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Root cause: the specific code/logic that caused it");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Fix: what was changed and why it works");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(
      "    · Evidence: paste the relevant error message or stack trace",
    );
  }
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  BLOCKED? If a task is unclear or missing context:");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    '    vibeflow tasks --edit <id> --comment "Blocked: <reason>. Need: <what is needed>."',
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("    Then pick the next task: vibeflow tasks --next");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "    Do not guess at unclear requirements — leave a comment and move on.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  CRITICAL: NEVER edit .vibeflow/ task files directly.");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "    All task operations (status, comments, commits) must go through CLI commands.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "  CRITICAL: Set in-progress BEFORE reading/planning. Other agents may pick the same task.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "    The in-progress transition signals ownership. Skip it and another agent may duplicate your work.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "    Sequence: discover tasks → pick one → set in-progress → THEN read details and implement.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push('  CRITICAL: NEVER set a task status to "done".');
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    '    When your implementation is complete, set the status to "review" — not "done".',
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "    Only humans can mark tasks as done after reviewing the work.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push(
    "    The CLI will warn you and still allow the change — but agents must not use it.",
  );
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("");

  return lines.join("\n");
}

// ── Migration: convert old .md + .json comments to new JSON format ─────────

/**
 * Migrates all legacy `.md` task files (+ separate comment JSON files) in a
 * project to the new single-file `.proto/tasks/{id}.json` format.
 * Idempotent: already-migrated tasks are skipped.
 */

// ── Migration: flat JSON → date-based directories ──────────────────────────

/**
 * Moves all flat `.proto/tasks/{id}.json` files into date-based subdirectories.
 * Idempotent: files already in a date directory are skipped.
 * Returns the number of files moved.
 */
export function migrateFlatTasksToDateDirs(projectDir: string): number {
  const tasksDir = getTasksDir(projectDir);
  if (!existsSync(tasksDir)) return 0;

  let moved = 0;
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue; // already in a date dir
    if (extname(entry.name) !== ".json") continue;

    const flatPath = join(tasksDir, entry.name);
    const task = readTaskFile(flatPath);
    if (!task) continue;

    const dateDir = join(tasksDir, getDateSubdir(task.created));
    const datePath = join(dateDir, entry.name);
    if (flatPath === datePath) continue; // already in the right place (shouldn't happen)

    mkdirSync(dateDir, { recursive: true });
    writeFileSync(datePath, JSON.stringify(task, null, 2), "utf-8");
    unlinkSync(flatPath);
    moved++;
  }
  return moved;
}
