/**
 * Parent→children sidecar index for the local done-cascade (owner rule:
 * a parent marked done marks all descendants done).
 *
 * WHY THIS EXISTS: finding a task's children requires a full store scan
 * (parent edges live on the CHILD records). Paying that scan on every
 * `--set-status done` turned 500 done-edits on a 5k-task store from <10s
 * into ~140s (`stress.test.ts`). This sidecar answers "children of X" in
 * O(1) — one small-file read plus a cheap generation check.
 *
 * CORRECTNESS CONTRACT (read carefully before touching this file):
 * - The index is a pure CACHE. Every failure mode degrades to one full
 *   rebuild, never to a wrong answer: a missing/corrupt/oversized/stale
 *   sidecar is rebuilt from a scan; a lock timeout falls back to an
 *   in-memory scan; NOTHING here ever throws into a task edit.
 * - Freshness is enforced by a GENERATION stamp: per-directory mtimes +
 *   entry counts over the task store (same clock basis as the lock
 *   staleness in `lock.ts`). Any task-file create/rename/unlink bumps a
 *   stamp component, so an undetected change is impossible on any
 *   filesystem with sane mtimes. Dot-entries (`.locks/`, sidecars) are
 *   EXCLUDED — lock churn must never read as store change.
 * - Writers that add/change/remove parent edges between LIVE tasks MUST
 *   invalidate (delete, never patch) the sidecar UNDER THE INDEX LOCK
 *   (see below) — currently `createTask`/`updateTask` (link edits),
 *   `deleteTask`, pull-apply, clone-write, and store-normalize.
 *   Writers that only touch other fields (comments, claims, reindex)
 *   leave the map valid; their mtime bumps just cost one rebuild on the
 *   next cascade. A missed invalidation is still safe: the generation
 *   check catches the mtime bump and rebuilds.
 * - INDEX-LOCK PROTOCOL: `withChildrenIndexLock` is always a LEAF — while
 *   holding it, take NO other lock (task, store-create, or index again)
 *   and do record I/O only. Every publish re-reads the sidecar under the
 *   lock first: a concurrent invalidation either deleted the file (→ we
 *   rebuild) or runs after us (→ it deletes our publish → the next read
 *   rebuilds). Residual: a cross-process edge-write landing in the
 *   sub-millisecond gap between our stamp recompute and our publish could
 *   stamp a map that misses it; every other interleaving self-heals via
 *   the generation check. (The pre-index code had the same hazard with a
 *   ~300ms window and no recovery.) Lock acquisition itself is
 *   best-effort: on timeout the caller falls back to a scan rather than
 *   failing the edit.
 * - Cycle safety and traversal still live in `task-links.ts`
 *   (`getDescendants`) — this module stores EDGES only. The cascade
 *   rebuilds minimal `{id, links}` rows from the edge map and walks them
 *   with that canonical walker; no second walker lives here.
 *
 * LOCATION: `<projectDir>/.vibeflow-state/task-children.json` — the
 * project-local state dir (same 0700-dir / 0600-file discipline as the
 * preflight state), NOT the synced `.vibeflow/tasks` store, so it is
 * never pushed, pulled, or merged.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PROTO_DIR, TASKS_DIR } from "./types.js";
import { taskLockPath, withFileLockSync } from "./lock.js";

export const CHILDREN_INDEX_FILENAME = "task-children.json";
export const CHILDREN_INDEX_VERSION = 1;
/** Refuse absurd sidecars before parsing (a healthy 5k-task map is ~200KB). */
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
/** Publish retries when the store changes mid-scan; then publish unstamped. */
const PUBLISH_ATTEMPTS = 3;

export interface ChildIndexDirStamp {
  rel: string;
  mtimeMs: number;
  count: number;
}

export interface ChildIndexGeneration {
  dirs: ChildIndexDirStamp[];
}

/** One parent edge: task `id` has a `parent` link to `parentId`. */
export interface ChildEdge {
  id: string;
  parentId: string;
}

export interface TaskChildrenIndex {
  version: number;
  generation: ChildIndexGeneration;
  /** parentId → direct child ids (sorted for stable bytes). */
  parents: Record<string, string[]>;
}

export function childrenIndexPath(projectDir: string): string {
  return join(projectDir, ".vibeflow-state", CHILDREN_INDEX_FILENAME);
}

function childrenIndexLockPath(projectDir: string): string {
  return taskLockPath(projectDir, ".children-index");
}

/**
 * Leaf-only index lock (see module contract). Best-effort: a timeout
 * THROWS, and every caller must catch it and fall back to a scan.
 */
export function withChildrenIndexLock<T>(
  projectDir: string,
  fn: () => T,
): T {
  return withFileLockSync(childrenIndexLockPath(projectDir), fn);
}

function getTasksDirPath(projectDir: string): string {
  return join(projectDir, PROTO_DIR, TASKS_DIR);
}

/**
 * Store generation: mtime + entry count for the tasks dir and each
 * immediate non-dot subdir (date shards). Flat task files count in the
 * top entry. Dot-entries (`.locks/`) are excluded — see module contract.
 */
export function computeChildrenIndexGeneration(
  projectDir: string,
): ChildIndexGeneration {
  const dirs: ChildIndexDirStamp[] = [];
  const tasksDir = getTasksDirPath(projectDir);
  const stampOne = (rel: string, abs: string): void => {
    try {
      const names = readdirSync(abs);
      const st = statSync(abs);
      dirs.push({ rel, mtimeMs: st.mtimeMs, count: names.length });
    } catch {
      /* a vanished dir reads as absent — the next check rebuilds */
    }
  };
  stampOne(".", tasksDir);
  let subdirs: string[] = [];
  try {
    subdirs = readdirSync(tasksDir).filter((n) => !n.startsWith("."));
  } catch {
    subdirs = [];
  }
  for (const name of subdirs.sort()) {
    let isDir = false;
    try {
      isDir = statSync(join(tasksDir, name)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) stampOne(name, join(tasksDir, name));
  }
  return { dirs };
}

function sameGeneration(
  a: ChildIndexGeneration,
  b: ChildIndexGeneration,
): boolean {
  if (a.dirs.length !== b.dirs.length) return false;
  return a.dirs.every(
    (d, i) =>
      d.rel === b.dirs[i].rel &&
      d.mtimeMs === b.dirs[i].mtimeMs &&
      d.count === b.dirs[i].count,
  );
}

function isValidIndex(value: unknown): value is TaskChildrenIndex {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== CHILDREN_INDEX_VERSION) return false;
  if (!v.generation || typeof v.generation !== "object") return false;
  const dirs = (v.generation as { dirs?: unknown }).dirs;
  if (!Array.isArray(dirs)) return false;
  if (
    !dirs.every(
      (d) =>
        d &&
        typeof d === "object" &&
        typeof (d as { rel?: unknown }).rel === "string" &&
        typeof (d as { mtimeMs?: unknown }).mtimeMs === "number" &&
        typeof (d as { count?: unknown }).count === "number",
    )
  )
    return false;
  if (!v.parents || typeof v.parents !== "object") return false;
  return Object.entries(v.parents as Record<string, unknown>).every(
    ([k, ids]) =>
      typeof k === "string" &&
      Array.isArray(ids) &&
      ids.every((id) => typeof id === "string"),
  );
}

/** Null on missing/corrupt/oversized/wrong-version. Never throws. */
export function readChildrenIndex(
  projectDir: string,
): TaskChildrenIndex | null {
  try {
    const path = childrenIndexPath(projectDir);
    if (statSync(path).size > MAX_INDEX_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isValidIndex(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the sidecar's stamp matches the store right now. */
export function isChildrenIndexFresh(
  projectDir: string,
  index: TaskChildrenIndex,
): boolean {
  try {
    return sameGeneration(
      index.generation,
      computeChildrenIndexGeneration(projectDir),
    );
  } catch {
    return false;
  }
}

export function buildChildrenIndex(
  edges: ChildEdge[],
  generation: ChildIndexGeneration,
): TaskChildrenIndex {
  const sets = new Map<string, Set<string>>();
  for (const { id, parentId } of edges) {
    if (!id || !parentId || id === parentId) continue;
    let set = sets.get(parentId);
    if (!set) {
      set = new Set<string>();
      sets.set(parentId, set);
    }
    set.add(id);
  }
  const parents: Record<string, string[]> = {};
  for (const [parentId, set] of [...sets.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    parents[parentId] = [...set].sort();
  }
  return { version: CHILDREN_INDEX_VERSION, generation, parents };
}

/**
 * Atomic publish (0700 dir / 0600 file / unique-tmp + rename, the same
 * discipline as the preflight state). Best-effort: never throws — a
 * failed write just costs the next cascade a rebuild.
 */
function writeChildrenIndexFile(
  projectDir: string,
  index: TaskChildrenIndex,
): void {
  const stateFile = childrenIndexPath(projectDir);
  const tmp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(join(projectDir, ".vibeflow-state"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
    renameSync(tmp, stateFile);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup only */
    }
  }
}

/**
 * Invalidate (delete, never patch). A missed invalidation is still safe —
 * the generation check catches the accompanying mtime bump and rebuilds.
 * Best-effort and lock-free: `unlink` is atomic, so it can never interleave
 * badly with a locked publish (either it lands first and the publish
 * rebuilds, or it deletes the publish and the next read rebuilds).
 *
 * EDGE-AFFECTING WRITERS: call `invalidateChildrenIndexLocked` (below),
 * NOT this, after changing parent edges — the locked variant orders the
 * unlink against concurrent publishes so a stale map can never be
 * resurrected with a fresh stamp. This bare variant is for node removals
 * (`deleteTask`): a stale entry for a deleted task can only produce a
 * skippable-missing lookup (see `deleteTask`), never a wrong cascade.
 */
export function invalidateChildrenIndex(projectDir: string): void {
  try {
    unlinkSync(childrenIndexPath(projectDir));
  } catch {
    /* already gone */
  }
}

/**
 * Locked invalidation for edge-adding/changing writers (create/update
 * link paths, pull-apply, clone-write, normalize): orders the unlink
 * against concurrent index publishes (see module contract). Best-effort:
 * never throws — the generation check still catches a missed unlink.
 */
export function invalidateChildrenIndexLocked(projectDir: string): void {
  try {
    withChildrenIndexLock(projectDir, () => {
      invalidateChildrenIndex(projectDir);
    });
  } catch {
    /* lock timeout — the stale stamp still forces a rebuild */
  }
}

/**
 * Publish helper shared by load and refresh: under the index lock,
 * re-read the sidecar and keep a usable disk copy when one exists;
 * otherwise scan, build, and publish. `expectStamp` (refresh path) pins
 * the expected prior stamp — anything else means a concurrent writer
 * invalidated or rebuilt, so we rebuild instead of overwriting.
 */
function publishLocked(
  projectDir: string,
  scan: () => ChildEdge[],
  expectStamp?: string,
): TaskChildrenIndex {
  return withChildrenIndexLock(projectDir, () => {
    const cur = readChildrenIndex(projectDir);
    if (expectStamp !== undefined) {
      // Refresh path: our own record writes landed since we loaded, so the
      // disk is NEVER generation-fresh here — and must not be required to
      // be. The stamp match alone is the proof: every edge-changing writer
      // invalidates under this same lock (`invalidateChildrenIndexLocked`),
      // so a matching stamp means no edge changed under us and the map is
      // still valid — just re-stamp it. Anything else (missing, different
      // stamp) means a concurrent writer moved: rebuild, never overwrite.
      if (cur && JSON.stringify(cur.generation) === expectStamp) {
        const refreshed: TaskChildrenIndex = {
          ...cur,
          generation: computeChildrenIndexGeneration(projectDir),
        };
        writeChildrenIndexFile(projectDir, refreshed);
        return refreshed;
      }
      // A concurrent writer moved: fall through to the rebuild below —
      // never overwrite a newer invalidation with our older map.
    } else if (cur && isChildrenIndexFresh(projectDir, cur)) {
      return cur;
    }
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
      // Generation FIRST, then scan: an edge that lands mid-scan reads as
      // a stamp mismatch on the next check (one extra rebuild), while the
      // reverse order could stamp a map that misses it (a wrong answer).
      const generation = computeChildrenIndexGeneration(projectDir);
      const built = buildChildrenIndex(scan(), generation);
      if (sameGeneration(generation, computeChildrenIndexGeneration(projectDir))) {
        writeChildrenIndexFile(projectDir, built);
        return built;
      }
    }
    // A persistently racing store: return the correct map WITHOUT
    // publishing it, so a possibly-stale sidecar can never outlive us.
    const generation = computeChildrenIndexGeneration(projectDir);
    return buildChildrenIndex(scan(), generation);
  });
}

/** Guarded scan: a failed scan degrades to parent-only, never to a refusal. */
function safeScan(scan: () => ChildEdge[]): ChildEdge[] {
  try {
    const rows = scan();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * The O(1) cascade read: a fresh index when the sidecar cooperates, one
 * rebuild when it does not. NEVER throws and NEVER fails the edit —
 * every fallback still cascades correctly, only slower.
 */
export function loadFreshChildrenIndex(
  projectDir: string,
  scan: () => ChildEdge[],
): TaskChildrenIndex {
  try {
    if (existsSync(childrenIndexPath(projectDir))) {
      const disk = readChildrenIndex(projectDir);
      if (disk && isChildrenIndexFresh(projectDir, disk)) return disk;
    }
  } catch {
    /* fall through to the locked publish */
  }
  try {
    return publishLocked(projectDir, () => safeScan(scan));
  } catch {
    // Lock timeout or worse: correct map, unpublished — the next edit
    // repairs the sidecar.
    return buildChildrenIndex(
      safeScan(scan),
      computeChildrenIndexGeneration(projectDir),
    );
  }
}

/**
 * Re-stamp after record writes that changed NO parent edges (the cascade's
 * own status writes): the map stays valid, only the stamp is stale.
 * Best-effort; staleness self-heals via the generation check.
 */
export function refreshChildrenIndex(
  projectDir: string,
  scan: () => ChildEdge[],
  index: TaskChildrenIndex,
): TaskChildrenIndex {
  try {
    return publishLocked(
      projectDir,
      () => safeScan(scan),
      JSON.stringify(index.generation),
    );
  } catch {
    return index;
  }
}
