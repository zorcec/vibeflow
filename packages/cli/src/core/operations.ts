/**
 * MCP Operations Layer
 *
 * Thin wrappers over core functions that MCP tools call.
 * These operations handle context resolution (projectDir, mode, userId)
 * and delegate to the existing core functions.
 * P1 shape (ticket 3d613068): the local record operations (list / get /
 * create / update / claim / comment / attach) live in `core/operations/`
 * and run against the async `TaskStore` ports; this file stays the
 * compatibility barrel and keeps the operations that a later phase extracts
 * (verify engine, sync, kanban lifecycle, guide).
 */
import { z } from "zod";
import { resolve } from "node:path";
import { getCurrentBranch, getProjectName } from "./config.js";

// ── Context ────────────────────────────────────────────────────────────────

/**
 * P1 ports (ticket 3d613068): migrated operations resolve their storage
 * through `store`/`artifacts` (see `resolveOperationPorts` in
 * `core/task-store.ts`) instead of importing `core/tasks.js` /
 * `comments.js` / `files.js` directly. Both are optional: an absent port
 * resolves to the shared local adapter, so every existing context
 * construction site (MCP server, chat-MCP, tests) keeps working unchanged
 * and no wire behaviour moves with the wiring.
 */
import type {
  LocalArtifactStore,
  TaskStore,
} from "./task-store.js";

export interface OperationContext {
  projectDir: string;
  mode: "local" | "saas";
  userId?: string;
  workspaceId?: string;
  dryRun?: boolean;
  store?: TaskStore;
  artifacts?: LocalArtifactStore;
}

// ── Result wrapper ─────────────────────────────────────────────────────────

/**
 * A note about work that is NOT a failure but the caller must know about: a
 * dry-run preview ("nothing was written"), a post-review auto-commit report,
 * "there was nothing to push".
 *
 * This is the same `{code, message}` shape the CLI puts on its `notices`
 * array, so one parser reads both surfaces. It is deliberately NOT the online
 * board's `warning` passthrough, which is a bare server-provided STRING.
 */
export interface OperationNotice {
  code: string;
  message: string;
}

/** The refusal half of `OperationResult`, named so a helper can return one. */
export interface OperationError {
  code: string;
  message: string;
  retryable?: boolean;
  suggestion?: string;
}

/**
 * P1 shape (ticket 3d613068): a DISCRIMINATED union — success carries data,
 * failure carries error, never both. The `data?: never` / `error?: never`
 * arms are what keep every existing reader compiling: `result.data` and
 * `result.error` stay accessible without narrowing, while `result.ok`
 * narrows the payload exactly. Wire-identical: the MCP envelope
 * (`successPayload` in src/mcp/server.ts) and the CLI renderers read the
 * same fields they always did.
 */
export type OperationResult<T> =
  | {
      ok: true;
      data?: T;
      error?: never;
      /**
       * Named `steps` INTERNALLY and on purpose: it is this layer's own vocabulary
       * and several call sites read it. The MCP wire key it serialises to is
       * `notices` (see `successPayload` in src/mcp/server.ts) — the rename is a
       * wire change only, so the two surfaces say `notices` to a consumer while
       * this file keeps the name it always had.
       */
      steps?: OperationNotice[];
    }
  | {
      ok: false;
      data?: never;
      error: OperationError;
      steps?: OperationNotice[];
    };

// ── Task resolution (the one existence check) ─────────────────────────────

/**
 * P1 home for resolution (ticket 3d613068): the resolver, its result type
 * and the shared `TASK_NOT_FOUND` suggestion live in
 * `core/operations/resolution.ts` and are re-exported here so the manifest,
 * the drift tests and every existing importer keep reading them from this
 * module unchanged.
 */
export {
  TASK_NOT_FOUND_SUGGESTION,
  resolveTaskOrRefusal,
  type TaskResolution,
} from "./operations/resolution.js";

/**
 * The `suggestion` `verify_task` falls back to when the verify engine's own
 * `VerifyError` carries none. It is a fallback, not a per-code table: the
 * engine's codes are NOT renamed and its own text always wins. Without it the
 * passthrough in `verifyTaskOp` forwarded the absence, and the README's
 * "every tool-level refusal carries a `suggestion`" had a reachable exception
 * (`E_NO_SELECTOR`, `E_AUTH_EXPIRED`, `E_AUTH_CORRUPT`, `E_APP_NOT_RUNNING`,
 * `E_NAVIGATION_FAILED`, `E_CANCELLED`).
 */
export const VERIFY_ERROR_SUGGESTION =
  "The verify engine refused before it could check anything — read `message` for the input it is missing, supply it (re-annotate the task if that input is not one you can set here), then run verify_task again";


// ── Dry run ────────────────────────────────────────────────────────────────

/**
 * A dry run is requested by EITHER the operation context (HTTP/SDK callers)
 * or the per-call tool input. Reading only ctx.dryRun let the MCP tools
 * advertise a `dryRun` input that was silently ignored, so a preview
 * performed a real write. Both sources must be honoured.
 */
export function isDryRun(
  ctx: OperationContext,
  input: { dryRun?: boolean },
): boolean {
  return ctx.dryRun === true || input.dryRun === true;
}
// ── Input schemas ──────────────────────────────────────────────────────────
// Canonical home is `@vibeflow-tools/api-core` (P4a decision (B): both the
// local and the hosted surface consume the same schemas); imported for the
// run functions below and re-exported so the manifest, the CLI and the
// drift tests keep importing from this module unchanged.
import {
  AddCommentInput,
  type AddCommentInputType,
  AttachFileInput,
  type AttachFileInputType,
  ClaimNextTaskInput,
  type ClaimNextTaskInputType,
  CreateTaskInput,
  type CreateTaskInputType,
  GetIntegrationGuideInput,
  type GetIntegrationGuideInputType,
  GetProjectInput,
  type GetProjectInputType,
  GetTaskInput,
  type GetTaskInputType,
  ListTasksInput,
  type ListTasksInputType,
  PullInput,
  type PullInputType,
  StartKanbanInput,
  type StartKanbanInputType,
  UpdateTaskInput,
  type UpdateTaskInputType,
  VerifyTaskInput,
  type VerifyTaskInputType,
} from "@vibeflow-tools/api-core";
export {
  AddCommentInput,
  type AddCommentInputType,
  AttachFileInput,
  type AttachFileInputType,
  ClaimNextTaskInput,
  type ClaimNextTaskInputType,
  CreateTaskInput,
  type CreateTaskInputType,
  GetIntegrationGuideInput,
  type GetIntegrationGuideInputType,
  GetProjectInput,
  type GetProjectInputType,
  GetTaskInput,
  type GetTaskInputType,
  ListTasksInput,
  type ListTasksInputType,
  PullInput,
  type PullInputType,
  StartKanbanInput,
  type StartKanbanInputType,
  UpdateTaskInput,
  type UpdateTaskInputType,
  VerifyTaskInput,
  type VerifyTaskInputType,
};

// pickTaskFields moved to `core/operations/tasks.ts` (re-exported below).


// attachOmissionCounts moved to `core/operations/files.ts`.


/** True for a Node listen() EADDRINUSE failure, on the error or its `cause`. */
function isAddrInUse(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return true;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return (cause as { code?: unknown } | undefined)?.code === "EADDRINUSE";
}

// ── Operations ─────────────────────────────────────────────────────────────

// listTasks moved to `core/operations/tasks.ts` (re-exported below).

// getTask moved to `core/operations/tasks.ts` (re-exported below).

/**
 * The project the server is attached to. `root` is always the startup-resolved
 * ctx.projectDir — accepting a root as input would break Model 1's invariant
 * that a tool can only *discover* the project, never retarget the server.
 */
export interface ProjectInfo {
  root: string;
  name: string;
  branch: string | null;
  mode: "local" | "saas";
}

export async function getProject(
  ctx: OperationContext,
  _input?: GetProjectInputType,
): Promise<OperationResult<ProjectInfo>> {
  // Mirror W2's `initialize` (mcp/server.ts): resolve once, then derive
  // name/branch from the same absolute path, so the handshake announcement
  // and this tool always report identical values.
  const abs = resolve(ctx.projectDir);
  return {
    ok: true,
    data: {
      root: abs,
      name: getProjectName(abs),
      branch: getCurrentBranch(abs),
      mode: ctx.mode,
    },
  };
}

// createTask moved to `core/operations/tasks.ts` (re-exported below).

// updateTask moved to `core/operations/tasks.ts` (re-exported below).

// claimNextTask moved to `core/operations/tasks.ts` (re-exported below).

// addComment moved to `core/operations/comments.ts` (re-exported below).

// attachFile moved to `core/operations/files.ts` (re-exported below).

// REMOVED (ticket 53b622fc, BREAKING): exportPrompt — the whole-board
// prompt exporter — was deleted with its export_prompt tool. Its single-task
// read is covered by get_task and its human render by `vibeflow tasks --get`
// (both via renderTaskForAgent in core/tasks.ts, which stays: the CLI
// display paths still use it). Callers needing the old
// multi-task dump: loop get_task over the ids from list_tasks.

// Verify task uses the CLI verify command
// Semaphore ensures only one verify runs at a time (spec §5.9)
let verifyTail: Promise<unknown> = Promise.resolve();
function withVerifySemaphore<T>(fn: () => Promise<T>): Promise<T> {
  const run = verifyTail.then(fn, fn);
  verifyTail = run.catch(() => undefined);
  return run;
}

export async function verifyTaskOp(
  ctx: OperationContext,
  input: VerifyTaskInputType,
): Promise<OperationResult<unknown>> {
  // Dry run FIRST, before the semaphore and before `../commands/verify.js` is
  // imported: the engine shells out to a browser, and a preview must not do
  // that work. Everything below this line (semaphore, timer, the E_NOT_FOUND /
  // E_NO_BASELINE / VERIFY_TIMEOUT refusal paths) behaves exactly as before.
  if (isDryRun(ctx, input)) {
    // P1: the existence probe runs through the port's own resolution rule —
    // the same first-match prefix rule the engine's exact lookup below
    // agrees with via the resolved id.
    const { resolveOperationPorts } = await import("./task-store.js");
    const { store } = resolveOperationPorts(ctx);
    const task = await store.getTask(ctx.projectDir, input.id);
    if (!task) {
      // The SAME refusal the real path raises: commands/verify.ts throws
      // VerifyError("E_NOT_FOUND", `Task not found: ${taskId}`, …) when
      // findTaskFilePath misses. A preview that answered ok:true with
      // data:null for an unresolvable id told the client the id was fine —
      // and updateTask's preview already refused the same case.
      return {
        ok: false,
        error: {
          code: "E_NOT_FOUND",
          message: `Task not found: ${input.id}`,
          suggestion:
            "That id resolves to no task — list_tasks (MCP) or 'vibeflow tasks' (CLI) to see the ids on this board",
        },
      };
    }
    return {
      ok: true,
      data: task,
      steps: [{ code: "DRY_RUN", message: "Verification would run" }],
    };
  }
  return withVerifySemaphore(async () => {
    const { verifyTask, addVerifySystemComment } = await import(
      "../commands/verify.js"
    );
    // ONE id rule. The port's `getTask` is the shared "full id, or a prefix
    // of one" rule every other task-bearing surface resolves through. The
    // dryRun preview above already resolved through it, so the real call has to
    // agree with its own preview: the raw input used to go straight to the
    // engine, which looks the task file up EXACTLY, so a prefix the preview
    // accepted was refused here with E_NOT_FOUND. The engine still raises that
    // code for an id that resolves to nothing (the port resolves unknown ids
    // to undefined and the raw input is passed through then) — its code is
    // not renamed here.
    const { resolveOperationPorts } = await import("./task-store.js");
    const { store } = resolveOperationPorts(ctx);
    const resolvedTask = await store.getTask(ctx.projectDir, input.id);
    const taskId = resolvedTask?.id ?? input.id;
    const timeoutMs = input.timeoutMs ?? 60_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();

    try {
      const result = await verifyTask(ctx.projectDir, taskId, {
        url: input.url,
        signal: ac.signal,
      } as { json?: boolean; url?: string; signal?: AbortSignal });
      // The RESOLVED id, always: a tool must never name a path it has not
      // resolved (the rule resolveTaskOrRefusal exists to enforce).
      await addVerifySystemComment(ctx.projectDir, taskId, result);
      return { ok: true, data: result };
    } catch (err) {
      const ve =
        err instanceof Error && "code" in err
          ? (err as { code: string; message: string; suggestion?: string })
          : null;
      if (ve) {
        return {
          ok: false,
          error: {
            code: ve.code,
            message: ve.message,
            // FALLBACK, not a rename. Several verify-engine codes carry no
            // `suggestion` of their own (E_NO_SELECTOR, E_AUTH_EXPIRED,
            // E_AUTH_CORRUPT, E_APP_NOT_RUNNING, E_NAVIGATION_FAILED,
            // E_CANCELLED), and this passthrough used to forward that absence
            // verbatim — so a reachable refusal arrived with a code and nothing
            // to act on, which is the one thing the contract forbids. The
            // engine's own text always wins when it has one; the code is
            // forwarded exactly as thrown.
            suggestion: ve.suggestion ?? VERIFY_ERROR_SUGGESTION,
          },
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "VERIFY_TIMEOUT" || ac.signal.aborted) {
        return {
          ok: false,
          error: {
            code: "VERIFY_TIMEOUT",
            message: `Verification timed out after ${input.timeoutMs}ms`,
            suggestion: "Increase timeoutMs or check that the app is running.",
          },
        };
      }
      return {
        ok: false,
        error: {
          code: "VERIFY_TASK_ERROR",
          message: msg,
          suggestion:
            "Check that the app under test is running and reachable at the task's url, then run verify_task again",
        },
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

export const PushTasksInput = z.object({
  workspace: z.string().optional(),
  keepLocalFiles: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});
export type PushTasksInputType = z.infer<typeof PushTasksInput>;

/**
 * Pull the online board into the local task store (the MCP spelling of
 * `vibeflow pull`). Additive and never destructive: the merge adds missing
 * tasks, merges conflicting fields (local wins unless `preferRemote`,
 * except `status`, which follows the remote record unless `preferLocal`),
 * and deletes nothing. `out` redirects the write target to another project
 * root; omit it to pull into the server's own project.
 */
export async function pullFromBoard(
  ctx: OperationContext,
  input: PullInputType,
): Promise<OperationResult<unknown>> {
  if (isDryRun(ctx, input)) {
    // Preview WITHOUT touching the network or the store: the counts a real
    // pull would report cannot be known without fetching the archive, so the
    // preview names the board selection it would pull from instead of
    // inventing numbers. Anything that would write answers this way.
    return {
      ok: true,
      data: {
        dryRun: true,
        board: input.board ?? null,
        out: input.out ?? null,
        preferRemote: input.preferRemote === true,
        preferLocal: input.preferLocal === true,
      },
      steps: [{ code: "DRY_RUN", message: "Pull would run" }],
    };
  }
  try {
    const { pull } = await import("../commands/pull.js");
    // silent: stdout is the JSON-RPC channel over MCP stdio — the human
    // lines pull() prints would corrupt the protocol stream.
    const result = await pull(ctx.projectDir, {
      board: input.board,
      out: input.out,
      preferRemote: input.preferRemote,
      preferLocal: input.preferLocal,
      dryRun: false,
      json: true,
      silent: true,
    });
    // pull() returns void on early exits (no login, no board selected).
    // Normalise to an object so the success envelope is always
    // serialisable — JSON.stringify(undefined) is undefined, which would
    // violate the MCP TextContent contract (text: string).
    return { ok: true, data: (result ?? {}) as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "PULL_ERROR",
        message: err instanceof Error ? err.message : "Failed to pull the board",
        suggestion:
          "Check the backend is reachable and you are logged in (vibeflow login); nothing was written, so retry",
      },
    };
  }
}

export async function pushTasks(
  ctx: OperationContext,
  input: PushTasksInputType,
): Promise<OperationResult<unknown>> {
  try {
    const { push } = await import("../commands/push.js");
    const result = await push(ctx.projectDir, {
      workspace: input.workspace,
      keepLocalFiles: input.keepLocalFiles,
      dryRun: input.dryRun,
    });
    // push() is typed Promise<PushResult | void> and returns void on early
    // exits (nothing to push, local mode, missing login). Normalise to an
    // object so the success envelope is always serialisable —
    // JSON.stringify(undefined) is undefined, which would violate the MCP
    // TextContent contract (text: string).
    return { ok: true, data: result ?? {} };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "PUSH_TASKS_ERROR",
        message: err instanceof Error ? err.message : "Failed to push tasks",
        suggestion:
          "Check the backend is reachable and you are logged in (vibeflow login); nothing was pushed, so retry",
      },
    };
  }
}

/**
 * Start the kanban board server and return the instruction block the CLI
 * prints (kanban URL, localhost alt URL when bound to 0.0.0.0, agent prompt,
 * integration guide).
 *
 * Idempotent: a second call returns the instance the first started
 * (`alreadyRunning: true`) rather than fighting it for the port — that is what
 * backs the tool's `idempotentHint: true`.
 *
 * A port already taken by some OTHER process is a clean tool-level refusal
 * (`KANBAN_PORT_IN_USE`), never a raw stack trace.
 */
export async function startKanban(
  ctx: OperationContext,
  input: StartKanbanInputType,
): Promise<OperationResult<unknown>> {
  try {
    // Dynamic import: the server pulls in the MCP HTTP transport, which imports
    // this module's registry — a static edge would be a require cycle.
    const { startKanbanServer, guideText, DEFAULT_KANBAN_PORT } = await import(
      "../server/kanban-server.js"
    );
    const { buildIntegrationGuide, resolveDisplayUrl } = await import(
      "../server/startup-guide.js"
    );
    const port = input.port ?? DEFAULT_KANBAN_PORT;
    const host = input.host ?? "localhost";

    // Preview: report what WOULD be served and bind nothing. Resolved through
    // the same URL rule the real serve() uses, so the preview names the same
    // URLs the real call will.
    if (input.dryRun) {
      const guide = buildIntegrationGuide(
        resolveDisplayUrl(host, port),
      );
      return {
        ok: true,
        data: {
          alreadyRunning: false,
          started: false,
          wouldStart: true,
          url: guide.url,
          localUrl: guide.localUrl,
          kanbanUrl: guide.kanbanUrl,
          taskApiUrl: guide.taskApiUrl,
          overlayScriptUrl: guide.overlayScriptUrl,
          injectUrl: guide.injectUrl,
          guide,
          instructions: guideText(guide, false),
        },
        steps: [
          {
            code: "DRY_RUN",
            message: `Kanban server would start on port ${port} (host ${host}); nothing was started`,
          },
        ],
      };
    }

    const { instance, started } = await startKanbanServer({
      projectDir: ctx.projectDir,
      port: input.port,
      host: input.host,
    });
    return {
      ok: true,
      data: {
        // `alreadyRunning: true` is the idempotent path — the caller is told
        // it did not just launch a second server.
        alreadyRunning: !started,
        started,
        url: instance.url,
        localUrl: instance.localUrl ?? null,
        kanbanUrl: instance.guide.kanbanUrl,
        taskApiUrl: instance.guide.taskApiUrl,
        overlayScriptUrl: instance.guide.overlayScriptUrl,
        injectUrl: instance.guide.injectUrl,
        guide: instance.guide,
        // ANSI-free: a tool payload must not carry terminal escapes.
        instructions: guideText(instance.guide, true),
      },
    };
  } catch (err) {
    if (isAddrInUse(err)) {
      return {
        ok: false,
        error: {
          code: "KANBAN_PORT_IN_USE",
          message: `Port ${input.port ?? 3700} is already in use, so the kanban server could not start.`,
          suggestion:
            "Pass a different `port`, or stop whatever is listening on that port. If Vibeflow is already running here, call start_kanban again without a port.",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "KANBAN_START_FAILED",
        message:
          err instanceof Error ? err.message : "Failed to start the kanban server",
        suggestion:
          "Check the port is free and the project directory is a Vibeflow project, then call start_kanban again",
      },
    };
  }
}

/**
 * The overlay/bookmarklet integration instructions — the content of the
 * `/inject` page, as text.
 *
 * Works whether or not the server is running. When it is not, the guide is
 * still returned (built against the default port) but carries an explicit
 * `serverRunning: false` and a note telling the caller to run `start_kanban`
 * first, so a client never mistakes a hypothetical URL for a live one.
 */
export async function getIntegrationGuide(
  _ctx: OperationContext,
  _input: GetIntegrationGuideInputType,
): Promise<OperationResult<unknown>> {
  try {
    const { getKanbanInstance, guideText, DEFAULT_KANBAN_PORT } = await import(
      "../server/kanban-server.js"
    );
    const { buildIntegrationGuide, resolveDisplayUrl } = await import(
      "../server/startup-guide.js"
    );
    const instance = getKanbanInstance();
    // Running -> the live instance's real URLs. Not running -> the default
    // port, flagged, so the caller knows to start the server first.
    const guide = instance
      ? instance.guide
      : buildIntegrationGuide(
          resolveDisplayUrl("localhost", DEFAULT_KANBAN_PORT),
        );
    return {
      ok: true,
      data: {
        serverRunning: !!instance,
        url: guide.url,
        localUrl: guide.localUrl,
        kanbanUrl: guide.kanbanUrl,
        taskApiUrl: guide.taskApiUrl,
        overlayScriptUrl: guide.overlayScriptUrl,
        injectUrl: guide.injectUrl,
        guide,
        instructions: guideText(guide, !!instance),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "INTEGRATION_GUIDE_ERROR",
        message:
          err instanceof Error
            ? err.message
            : "Failed to build the integration guide",
        suggestion:
          "This is a read-only tool; retry it, and check the project directory if it keeps failing",
      },
    };
  }
}

// ── P1 re-exports ──────────────────────────────────────────────────────────
//
// The migrated local operations. `core/operations.ts` stays the
// compatibility barrel: the P0 registry callable bindings, the manifest
// and every existing importer keep resolving these symbols here.
export {
  listTasks,
  listAllTasksForCli,
  getTask,
  createTask,
  updateTask,
  claimNextTask,
  pickTaskFields,
} from "./operations/tasks.js";
export type { ListAllTasksInput } from "./operations/tasks.js";
export { addComment } from "./operations/comments.js";
export {
  attachFile,
  attachStandalone,
  type AttachSourceInput,
  type AttachStandaloneInput,
  type AttachStandaloneData,
} from "./operations/files.js";
