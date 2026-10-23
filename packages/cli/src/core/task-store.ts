import type { Task, TaskComment } from "./types.js";
import type { FileInfo } from "./files.js";
import type { TaskReadFinding } from "./task-record-read.js";
import type {
  TaskNormalizePlan,
  TaskNormalizeReport,
} from "./tasks.js";
import * as tasksModule from "./tasks.js";
import * as commentsModule from "./comments.js";
import * as filesModule from "./files.js";
import { selectClaimCandidate } from "./claim-eligibility.js";
import { resolveSaasTaskId } from "./id-resolution.js";

/**
 * P1 seam (ticket 3d613068, parent e7482da5): operation-facing PORTS over the
 * synchronous file-backed store. Every method returns a Promise so local MCP
 * operations `await` storage instead of assuming it settles synchronously —
 * a remote adapter behind the same interface may resolve over the network.
 *
 * The underlying `core/tasks.ts`, `core/comments.ts` and `core/files.ts`
 * functions stay SYNCHRONOUS and untouched: `LocalTaskStore` below only
 * wraps them. No logic lives here beyond delegation, prefix-rule reuse, and
 * the claim preview/live filter pairing.
 */

export type TaskCreateInput = Omit<
  Task,
  "id" | "created" | "comments" | "files"
>;
export type TaskUpdateInput = Partial<Omit<Task, "id" | "created">>;

/** Options for the atomic claim primitive (mirrors claimNextTaskAtomic). */
export interface ClaimOptions {
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
   */
  allowInactiveParentChain?: boolean;
}

/**
 * Portable resolution outcome: WHY a task id did or did not resolve, without
 * exposing the filesystem path that decided it. `missing` (no record) and
 * `unreadable` (a record exists but does not parse) stay distinguishable so
 * the refusal codes built on them (`TASK_NOT_FOUND` vs `TASK_READ_ERROR`)
 * keep their distinct recoveries on every adapter.
 */
export type TaskResolveOutcome =
  | { status: "found"; id: string; task: Task }
  | { status: "missing"; id: string }
  | { status: "unreadable"; id: string }
  // P2 (ticket d7b9dc13): an ambiguous prefix resolves to NO task — the
  // one-id-rule refusal (`E_AMBIGUOUS` naming the candidates), never a
  // silent first-match. Carried as an outcome (not a throw) so every
  // adapter reports it the same way and the operation maps it once.
  | { status: "ambiguous"; id: string; candidates: string[] };

/** Attachment validation verdict (mirrors `FileValidationResult`). */
export interface AttachmentValidation {
  valid: boolean;
  errorCode: string;
  errorMessage: string;
  errorSuggestion?: string;
}

/** A read-only claim preview: the candidate the atomic claim would take. */
export interface ClaimPreview {
  task: Task;
  /** True when the preview names a child of live work (no todo root). */
  childClaim: boolean;
  /** The sliced child's parent id, for the CHILD_CLAIM notice. */
  parentId: string | null;
}

/**
 * Portable, PATH-FREE record port. No method takes or returns a filesystem
 * path: resolution, reads, writes and the atomic claim all work on ids and
 * records. Anything that needs bytes-on-disk (verify engines, download
 * routes) goes through `LocalArtifactStore` instead — never this interface.
 */
export interface TaskStore {
  /**
   * Transport-level narrowing HINT (LANE Q step 2, extended ticket 05076246):
   * the adapter MAY return fewer rows ONLY by applying a predicate-equal
   * subset of the caller's query before returning — an exact status match
   * the server can express (`?status=`), and — when `sort: "kanban"` rides
   * alongside a positive `limit` — the server-ordered top-K page
   * (`?sort=kanban&limit=K`). The top-K page is trusted ONLY where the
   * server's scope matches the client's (the caller guarantees this: a
   * child-inclusive scope — `--children` or a status-filtered search —
   * over a pushable status or no status; never root-only, never `done`,
   * never with type/user/tag filters the server has no param for). The
   * caller MUST still run the full query (queryTaskList) over the result,
   * and adapters that cannot express the hint (local files, old servers)
   * ignore it and return the whole board. Exactness rests on the predicate
   * + ordering equality, pinned by the adapter's same-row tests — never
   * infer "these are the top N after sorting" from a narrowed result
   * unless `sort: "kanban"` was honoured (the client checks the `order`
   * echo and falls back to the full scan otherwise).
   */
  listTasks(
    projectDir: string,
    reads?: TaskReadFinding[],
    preFilter?: {
      status?: string;
      sort?: "kanban";
      limit?: number;
      /**
       * `roots` = the caller's scope is roots-only (default unfiltered
       * listing): forward as `?scope=roots` with the top-K hint. Absent =
       * the caller's scope includes children (filtered search or
       * `--children`), so no scope param is sent. Never combined with a
       * status filter — a filtered search includes children by contract,
       * so narrowing it to roots would silently drop rows.
       */
      scope?: "roots";
      /** True when the caller's scope includes children. */
      children?: boolean;
    },
  ): Promise<Task[]>;
  /**
   * Full id OR id prefix (first match in list order, exact id included —
   * the CLI's long-standing rule, reused here rather than reinvented).
   * Unreadable records resolve as `undefined`, exactly like the list
   * snapshot link validation reads: direct id access that must tell
   * "missing" from "unreadable" uses `resolveTask` instead.
   */
  getTask(
    projectDir: string,
    idOrPrefix: string,
  ): Promise<Task | undefined>;
  /** Missing vs unreadable, without a filesystem path. */
  resolveTask(
    projectDir: string,
    idOrPrefix: string,
  ): Promise<TaskResolveOutcome>;
  /**
   * P2 (ticket d7b9dc13): the minimal board slice the relations view
   * derives from for ONE task. The local adapter answers the full list
   * (the relations need the whole board); a remote adapter answers the
   * detail-derived slice instead, so a single read never costs a board
   * enumeration. Optional so third-party fakes keep working — callers fall
   * back to `listTasks` when it is absent.
   */
  relationScope?(projectDir: string, taskId: string): Promise<Task[]>;
  createTask(
    projectDir: string,
    input: TaskCreateInput,
  ): Promise<Task>;
  updateTask(
    projectDir: string,
    taskId: string,
    updates: TaskUpdateInput,
  ): Promise<Task | null>;
  deleteTask(projectDir: string, taskId: string): Promise<boolean>;
  listComments(
    projectDir: string,
    taskId: string,
  ): Promise<TaskComment[]>;
  addComment(
    projectDir: string,
    taskId: string,
    author: TaskComment["author"],
    text: string,
    files?: string[],
    type?: TaskComment["type"],
    source?: TaskComment["source"],
  ): Promise<TaskComment>;
  updateComment(
    projectDir: string,
    taskId: string,
    commentId: string,
    newText: string,
  ): Promise<TaskComment | null>;
  deleteComment(
    projectDir: string,
    taskId: string,
    commentId: string,
  ): Promise<boolean>;
  listFiles(projectDir: string, taskId: string): Promise<FileInfo[]>;
  /**
   * Attachment gate (manifest files, executable extensions, size cap).
   * Policy lives in the ADAPTER: the local rule wraps
   * `core/files.ts validateFilename`, and a remote board answers by its
   * own rule in a later phase — the operation only enforces the verdict.
   */
  validateAttachment(
    projectDir: string,
    filename: string,
    sizeBytes: number,
  ): Promise<AttachmentValidation>;
  saveFile(
    projectDir: string,
    taskId: string,
    filename: string,
    data: Buffer,
    opts?: { system?: boolean },
  ): Promise<FileInfo>;
  deleteFile(
    projectDir: string,
    taskId: string,
    filename: string,
  ): Promise<boolean>;
  getFileCount(projectDir: string, taskId: string): Promise<number>;
  /**
   * THE atomic claim: snapshot, re-verify and write happen inside one lock,
   * so two concurrent claimants never take the same task. Never reimplement
   * this as list+update at a call site — that read-then-write races, and the
   * port-boundary race test proves it (concurrent claims collide without
   * this primitive).
   */
  claimNextTaskAtomic(
    projectDir: string,
    opts?: ClaimOptions,
  ): Promise<Task | null>;
  /**
   * Read-only preview of the atomic claim: the SAME selector
   * (`selectClaimCandidate` — roots-first / live-children fallback /
   * unfinished-blocker suppression) the live path applies, but nothing is
   * written. Deliberately local: a remote board previews by the versioned
   * agent-claim contract (P3), and this preview never activates one.
   *
   * Fixed divergence (ticket 6452504d): the preview used to omit the
   * blocked-by-unfinished-work check, so it could name a task the live
   * claim skipped. Both now select through one selector.
   */
  previewClaim(
    projectDir: string,
    opts?: ClaimOptions,
  ): Promise<ClaimPreview | null>;
  /**
   * P5 maintenance ports (ticket 4a5f7df6): local-only store healing and
   * sort-key backfill. Optional so remote adapters and third-party fakes
   * keep working — there is no cloud normalization, so callers fall back
   * to the local adapter when these are absent (the same fallback shape
   * as the optional `relationScope` above). `LocalTaskStore` below
   * delegates 1:1 to `core/tasks.ts`, like every other port.
   */
  planNormalize?(projectDir: string): Promise<TaskNormalizeReport>;
  applyNormalize?(projectDir: string): Promise<{
    applied: TaskNormalizePlan[];
    unwritten: string[];
    unreadable: string[];
    quarantined: TaskReadFinding[];
  }>;
  writeSortKey?(
    projectDir: string,
    taskId: string,
    sortKey: string,
  ): Promise<boolean>;
}

/**
 * LOCAL-ONLY artifact access: filesystem paths and raw bytes. Explicitly NOT
 * portable — a remote adapter has no task file paths to hand out. Only
 * local-only consumers (the verify engine, download routes, the review-gate
 * compatibility wrapper's predecessor reads) may touch this; portable
 * operation modules must not import it.
 */
export interface LocalArtifactStore {
  getFilePath(
    projectDir: string,
    taskId: string,
    filename: string,
  ): string | null;
}

/** The ports an operation runs against (both default to the local store). */
export interface OperationPorts {
  store: TaskStore;
  artifacts: LocalArtifactStore;
}

/**
 * File-backed ports: every method delegates 1:1 to the existing
 * `core/tasks.ts`, `core/comments.ts`, and `core/files.ts` functions.
 * No logic lives here — a spy on the underlying module proves the delegation.
 */
export class LocalTaskStore implements TaskStore, LocalArtifactStore {
  async listTasks(
    projectDir: string,
    reads?: TaskReadFinding[],
  ): Promise<Task[]> {
    return tasksModule.listTasks(projectDir, reads);
  }

  async getTask(
    projectDir: string,
    idOrPrefix: string,
  ): Promise<Task | undefined> {
    return tasksModule.findTaskByIdOrPrefix(projectDir, idOrPrefix);
  }

  async resolveTask(
    projectDir: string,
    idOrPrefix: string,
  ): Promise<TaskResolveOutcome> {
    // P2 (ticket d7b9dc13): the ONE shared id rule (`resolveSaasTaskId`
    // over this adapter's own snapshot) — exact id wins, a UNIQUE prefix
    // resolves, an ambiguous prefix is an `ambiguous` outcome, never a
    // silent first-match. The old first-match guess is gone: `--get`,
    // `--edit`, and every task-scoped MCP tool refuse ambiguity through
    // the same `resolveTaskOrRefusal` mapping.
    //
    // Ordering matters: the snapshot silently skips records that do not
    // parse, so an exact id naming a CORRUPT file must be checked directly
    // first — otherwise it would vanish into `missing` and the
    // TASK_READ_ERROR recovery ("the file exists but did not parse")
    // would never fire. A prefix never names a file directly
    // (`findTaskFilePath` matches exact filenames only), so prefixes
    // always take the snapshot rule below.
    const directPath = tasksModule.findTaskFilePath(projectDir, idOrPrefix);
    if (directPath) {
      const task = tasksModule.readTaskFile(directPath);
      if (!task) return { status: "unreadable", id: idOrPrefix };
      return { status: "found", id: idOrPrefix, task };
    }
    const resolved = resolveSaasTaskId(
      await tasksModule.listTasks(projectDir),
      idOrPrefix,
    );
    if (!resolved.ok) {
      // The rule reports unknown AND empty ids as TASK_NOT_FOUND; only an
      // ambiguous prefix carries candidates.
      if (resolved.code === "E_AMBIGUOUS") {
        return {
          status: "ambiguous",
          id: idOrPrefix,
          candidates: resolved.candidates,
        };
      }
      return { status: "missing", id: idOrPrefix };
    }
    const filePath = tasksModule.findTaskFilePath(projectDir, resolved.id);
    if (!filePath) return { status: "missing", id: resolved.id };
    const task = tasksModule.readTaskFile(filePath);
    if (!task) return { status: "unreadable", id: resolved.id };
    return { status: "found", id: resolved.id, task };
  }

  async createTask(
    projectDir: string,
    input: TaskCreateInput,
  ): Promise<Task> {
    return tasksModule.createTask(projectDir, input);
  }

  async updateTask(
    projectDir: string,
    taskId: string,
    updates: TaskUpdateInput,
  ): Promise<Task | null> {
    return tasksModule.updateTask(projectDir, taskId, updates);
  }

  async deleteTask(
    projectDir: string,
    taskId: string,
  ): Promise<boolean> {
    return tasksModule.deleteTask(projectDir, taskId);
  }

  async listComments(
    projectDir: string,
    taskId: string,
  ): Promise<TaskComment[]> {
    return commentsModule.listComments(projectDir, taskId);
  }

  addComment(
    projectDir: string,
    taskId: string,
    author: TaskComment["author"],
    text: string,
    files?: string[],
    type?: TaskComment["type"],
    source?: TaskComment["source"],
  ): Promise<TaskComment> {
    return commentsModule.addComment(
      projectDir,
      taskId,
      author,
      text,
      files,
      type,
      source,
    );
  }

  updateComment(
    projectDir: string,
    taskId: string,
    commentId: string,
    newText: string,
  ): Promise<TaskComment | null> {
    return commentsModule.updateComment(projectDir, taskId, commentId, newText);
  }

  deleteComment(
    projectDir: string,
    taskId: string,
    commentId: string,
  ): Promise<boolean> {
    return commentsModule.deleteComment(projectDir, taskId, commentId);
  }

  async listFiles(
    projectDir: string,
    taskId: string,
  ): Promise<FileInfo[]> {
    return filesModule.listFiles(projectDir, taskId);
  }

  async saveFile(
    projectDir: string,
    taskId: string,
    filename: string,
    data: Buffer,
    opts?: { system?: boolean },
  ): Promise<FileInfo> {
    return filesModule.saveFile(projectDir, taskId, filename, data, opts);
  }

  async deleteFile(
    projectDir: string,
    taskId: string,
    filename: string,
  ): Promise<boolean> {
    return filesModule.deleteFile(projectDir, taskId, filename);
  }

  async validateAttachment(
    projectDir: string,
    filename: string,
    sizeBytes: number,
  ): Promise<AttachmentValidation> {
    void projectDir;
    const verdict = filesModule.validateFilename(filename, sizeBytes);
    return {
      valid: verdict.valid,
      errorCode: verdict.valid ? "" : verdict.errorCode,
      errorMessage: verdict.valid ? "" : verdict.errorMessage,
      errorSuggestion: verdict.valid
        ? undefined
        : verdict.errorSuggestion,
    };
  }

  async getFileCount(
    projectDir: string,
    taskId: string,
  ): Promise<number> {
    return filesModule.getFileCount(projectDir, taskId);
  }

  async claimNextTaskAtomic(
    projectDir: string,
    opts?: ClaimOptions,
  ): Promise<Task | null> {
    return tasksModule.claimNextTaskAtomic(projectDir, opts);
  }

  async previewClaim(
    projectDir: string,
    opts?: ClaimOptions,
  ): Promise<ClaimPreview | null> {
    // Read-only mirror of the live claim's two-phase shape (see
    // `claimNextTask` in `core/operations/tasks.ts`): roots first, then the
    // live-children fallback — both through the SAME selector
    // (`selectClaimCandidate`, with unfinished-blocker suppression), but no
    // lock and no write. P3 fix (ticket 6452504d): the old inline filter
    // omitted the blocked-by-unfinished-work check the live claim applies,
    // so on a board whose top candidate was blocked the preview named a
    // task the live call skipped. One selector means one policy — the two
    // cannot drift apart unnoticed.
    const board = tasksModule.listTasks(projectDir);
    const selection =
      selectClaimCandidate(board, { ...opts, rootsOnly: true }) ??
      selectClaimCandidate(board, opts);
    if (!selection) return null;
    return {
      task: selection.task,
      childClaim: selection.childClaim,
      parentId: selection.parentId,
    };
  }

  async planNormalize(
    projectDir: string,
  ): Promise<TaskNormalizeReport> {
    return tasksModule.planTaskStoreNormalize(projectDir);
  }

  async applyNormalize(projectDir: string): Promise<{
    applied: TaskNormalizePlan[];
    unwritten: string[];
    unreadable: string[];
    quarantined: TaskReadFinding[];
  }> {
    return tasksModule.applyTaskStoreNormalize(projectDir);
  }

  async writeSortKey(
    projectDir: string,
    taskId: string,
    sortKey: string,
  ): Promise<boolean> {
    return tasksModule.writeSortKeyMinimal(projectDir, taskId, sortKey);
  }

  getFilePath(
    projectDir: string,
    taskId: string,
    filename: string,
  ): string | null {
    return filesModule.getFilePath(projectDir, taskId, filename);
  }
}

/** Shared file-backed ports (selection by auth state lands in P3). */
export const localTaskStore = new LocalTaskStore();

/**
 * Injection point for operation contexts: an explicitly passed store wins
 * (tests, and remote boards in a later phase); otherwise the local adapter.
 * Every migrated operation resolves its ports through here — never by
 * importing `core/tasks.js` / `comments.js` / `files.js` itself.
 */
export function resolveOperationPorts(ctx: {
  store?: TaskStore;
  artifacts?: LocalArtifactStore;
}): OperationPorts {
  return {
    store: ctx.store ?? localTaskStore,
    artifacts: ctx.artifacts ?? localTaskStore,
  };
}
