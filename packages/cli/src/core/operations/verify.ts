/**
 * Verify operations (ticket 453c7465, P7 verify increment).
 *
 * The shared implementations behind `vibeflow verify <task-id>` (engine
 * form), the `verify style_query|style_diff|element_info|html_diff|html_query
 * <task-id>` evidence forms, and the `verify_task` MCP tool. Both are
 * visibly local (registry requirement `local-only`, no evidence MCP tool):
 * they read the board's task files, shell out to a local browser, and write
 * system comments — never the network beyond the app under test. They run
 * through injected ports so unit tests drive fakes instead of launching
 * browsers or touching the store; `src/index.ts` keeps flag parsing and the
 * exit code while every decision about WHAT to verify lives here.
 *
 * Contracts (each mirrors the inline branch it replaces):
 *
 * verifyTaskOp — owns the ONE wall-clock bound (a single timer installed
 * here; the CLI handler passes `timeoutMs` through and installs nothing of
 * its own) and the ONE id rule (exact id wins, a UNIQUE prefix resolves, an
 * ambiguous prefix is refused E_AMBIGUOUS — the same rule every other
 * task surface resolves through). The dry-run preview resolves through the
 * same rule so it names the same task the live call would verify. Engine
 * codes and their text always win (a missing `suggestion` falls back to
 * VERIFY_ERROR_SUGGESTION); the timer message reports the RESOLVED bound,
 * never the possibly-absent raw input. One semaphore serialises concurrent
 * runs (spec §5.9); exactly one system comment is written per run, and the
 * operation never sets a verdict — `result.ok` is page-health evidence, the
 * agent attests with `--set-verify` at review.
 *
 * inspectVerificationEvidence — the data half of the evidence-query forms.
 * It resolves the task, loads the STATIC captured evidence, and dispatches
 * the pure query (`style_query`, `style_diff`, `element_info`, `html_diff`,
 * `html_query`); `commands/verify-tools.ts` stays the compatibility
 * renderer and keeps every usage line, stdout/stderr shape, and exit code.
 * Tool-level misses ("run verify first", bad property/queryType) travel as
 * DATA (`{ok:false}`), exactly as the renderer printed them — only a task
 * that cannot be resolved or an evidence artifact that cannot be trusted is
 * an operation refusal. No browser is launched and no verdict is recorded.
 *
 * What stays out: the engine itself (`commands/verify.ts`), the evidence
 * file formats and query logic (`commands/verify-tools.ts`, `core/page-diff.ts`),
 * the verdict/attestation model (`core/verify-attestation.ts`), and the
 * renderers. Kanban CLI routing is the one named P7 remainder after this.
 */
import type {
  OperationContext,
  OperationError,
  OperationResult,
} from "../operations.js";
import { isDryRun, VERIFY_ERROR_SUGGESTION } from "../operations.js";
import { resolveOperationPorts } from "../task-store.js";
import type { TaskStore } from "../task-store.js";
import type { VerifyTaskInputType } from "../operations.js";
import type { VerifyResult } from "../../commands/verify.js";
import type { EvidenceSet } from "../../commands/verify-tools.js";

// ── Shared id resolution ─────────────────────────────────────────────────

/**
 * What the verify operations resolved an id-or-prefix to. `refusal` is the
 * ambiguous-prefix case only: a missing or unreadable record is NOT refused
 * here — each caller keeps its own "not found" wording (the engine's
 * E_NOT_FOUND, the evidence form's "Task not found"), exactly as before.
 * A resolution that throws (a store the test seam did not provide) also
 * falls through to the caller's own lookup — resolution is best-effort, the
 * engine/evidence reads are authoritative.
 */
type ResolvedVerifyId =
  | { id: string; refusal?: never }
  | { id?: never; refusal: OperationError };

async function resolveVerifyTaskId(
  ctx: OperationContext,
  store: TaskStore,
  idOrPrefix: string,
): Promise<ResolvedVerifyId> {
  let outcome: Awaited<ReturnType<TaskStore["resolveTask"]>>;
  try {
    outcome = await store.resolveTask(ctx.projectDir, idOrPrefix);
  } catch {
    return { id: idOrPrefix };
  }
  if (outcome.status === "found") return { id: outcome.id };
  if (outcome.status === "ambiguous") {
    // The one-id-rule refusal: the prefix named several tasks, so it names
    // none. Same code, message, and suggestion the CLI's other task surfaces
    // and the port-based resolver refuse with, so local ambiguity refuses
    // identically everywhere.
    return {
      refusal: {
        code: "E_AMBIGUOUS",
        message: `Ambiguous task id prefix "${outcome.id}" matches ${outcome.candidates.length} tasks: ${outcome.candidates.join(", ")}`,
        suggestion:
          "Use the full task id — run 'vibeflow tasks' to see available task IDs.",
      },
    };
  }
  return { id: idOrPrefix };
}

// ── verifyTaskOp ─────────────────────────────────────────────────────────

let verifyTail: Promise<unknown> = Promise.resolve();
function withVerifySemaphore<T>(fn: () => Promise<T>): Promise<T> {
  const run = verifyTail.then(fn, fn);
  verifyTail = run.catch(() => undefined);
  return run;
}

/** What the verify engine needs, minus the module identity (injected). */
export type VerifyEngineFn = (
  projectDir: string,
  taskId: string,
  opts: { url?: string; signal?: AbortSignal },
) => Promise<VerifyResult>;

/** What the system-comment write needs, minus the module identity. */
export type VerifyCommentFn = (
  projectDir: string,
  taskId: string,
  result: VerifyResult,
) => Promise<void>;

export interface VerifyTaskPorts {
  /** Runs the engine. Defaults to the real `verifyTask` (dynamic import, like the barrel before). */
  runEngine?: VerifyEngineFn;
  /** Writes the system comment. Defaults to the real `addVerifySystemComment`. */
  writeComment?: VerifyCommentFn;
  /** Resolves id-or-prefix. Defaults to the port store's shared unique-prefix rule. */
  resolveId?: (
    ctx: OperationContext,
    idOrPrefix: string,
  ) => Promise<ResolvedVerifyId>;
  /** Timer the wall-clock bound runs on. Defaults to the real globals; fakes count installs in tests. */
  setTimer?: (handler: () => void, ms: number) => unknown;
  /** Clears the wall-clock bound. Defaults to the real global. */
  clearTimer?: (handle: unknown) => void;
}

async function defaultResolveId(
  ctx: OperationContext,
  idOrPrefix: string,
): Promise<ResolvedVerifyId> {
  const { store } = resolveOperationPorts(ctx);
  return resolveVerifyTaskId(ctx, store, idOrPrefix);
}

export async function verifyTaskOp(
  ctx: OperationContext,
  input: VerifyTaskInputType,
  ports: VerifyTaskPorts = {},
): Promise<OperationResult<unknown>> {
  const resolveId = ports.resolveId ?? defaultResolveId;
  // Dry run FIRST, before the semaphore and before the engine module is
  // imported: the engine shells out to a browser, and a preview must not do
  // that work. The preview resolves through the SAME unique-prefix rule as
  // the live call below, so it names the same task the live call verifies.
  if (isDryRun(ctx, input)) {
    const resolved = await resolveId(ctx, input.id);
    if (resolved.refusal) return { ok: false, error: resolved.refusal };
    const { store } = resolveOperationPorts(ctx);
    let task;
    try {
      task = await store.getTask(ctx.projectDir, resolved.id);
    } catch {
      task = undefined;
    }
    if (!task) {
      // The SAME refusal the real path raises: the engine throws
      // VerifyError("E_NOT_FOUND", `Task not found: ${taskId}`, …) when its
      // exact lookup misses. A preview that answered ok:true with data:null
      // for an unresolvable id told the client the id was fine — and
      // updateTask's preview already refused the same case.
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
    const runEngine =
      ports.runEngine ??
      ((await import("../../commands/verify.js")).verifyTask as VerifyEngineFn);
    const writeComment =
      ports.writeComment ??
      ((await import("../../commands/verify.js"))
        .addVerifySystemComment as VerifyCommentFn);
    // ONE id rule. The resolved id goes to the engine AND the comment: a
    // tool must never name a path it has not resolved (the rule
    // resolveTaskOrRefusal exists to enforce). A prefix the rule cannot
    // resolve to exactly one task is refused above; an id that resolves to
    // nothing passes through raw and the engine raises its own E_NOT_FOUND —
    // its code is not renamed here.
    const resolved = await resolveId(ctx, input.id);
    if (resolved.refusal) return { ok: false, error: resolved.refusal };
    const taskId = resolved.id;
    const timeoutMs = input.timeoutMs ?? 60_000;
    const setTimer = ports.setTimer ?? ((h, ms) => setTimeout(h, ms));
    const clearTimer =
      ports.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const ac = new AbortController();
    const timer = setTimer(() => ac.abort(), timeoutMs);
    // `unref` is a Node Timer nicety the fakes do not provide; the bound
    // must not keep the process alive on its own when the real timer runs.
    (timer as { unref?: () => void })?.unref?.();

    try {
      const result = await runEngine(ctx.projectDir, taskId, {
        url: input.url,
        signal: ac.signal,
      });
      await writeComment(ctx.projectDir, taskId, result);
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
            // The RESOLVED bound: the raw input may omit timeoutMs (the
            // schema default applies), and reporting "undefinedms" told the
            // caller nothing about the bound that actually fired.
            message: `Verification timed out after ${timeoutMs}ms`,
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
      clearTimer(timer);
    }
  });
}

// ── inspectVerificationEvidence ──────────────────────────────────────────

export type EvidenceQueryTool =
  | "style_query"
  | "style_diff"
  | "element_info"
  | "html_diff"
  | "html_query";

export interface InspectVerificationEvidenceInput {
  /** Task id (full id or unique prefix — same rule as the engine form). */
  taskId: string;
  /** Which evidence query to run. Anything else is a tool-level miss, not a refusal. */
  tool: string;
  /** Required by style_query: the CSS property to look up. */
  property?: string;
  /** style_diff only: filter properties by substring. */
  filter?: string;
  /** Required by html_query: children|text|attributes. */
  queryType?: string;
}

export interface InspectVerificationEvidencePorts {
  /** Loads the static captured evidence. Defaults to the real `readEvidence`. */
  loadEvidence?: (projectDir: string, taskId: string) => Promise<EvidenceSet>;
  /** Resolves id-or-prefix. Defaults to the port store's shared unique-prefix rule. */
  resolveId?: (
    ctx: OperationContext,
    idOrPrefix: string,
  ) => Promise<ResolvedVerifyId>;
}

export async function inspectVerificationEvidence(
  ctx: OperationContext,
  input: InspectVerificationEvidenceInput,
  ports: InspectVerificationEvidencePorts = {},
): Promise<OperationResult<Record<string, unknown>>> {
  const resolveId = ports.resolveId ?? defaultResolveId;
  const resolved = await resolveId(ctx, input.taskId);
  if (resolved.refusal) return { ok: false, error: resolved.refusal };
  if (resolved.id !== input.taskId) {
    // A unique prefix resolved: the evidence reads below must use the full
    // id (a tool must never name a path it has not resolved). An id that
    // resolves to nothing keeps its own "not found" wording below.
    input = { ...input, taskId: resolved.id };
  } else {
    const { store } = resolveOperationPorts(ctx);
    let exists = false;
    try {
      exists = (await store.getTask(ctx.projectDir, resolved.id)) !== undefined;
    } catch {
      exists = false;
    }
    if (!exists) {
      // The SAME wording the CLI evidence form prints today when the task
      // file lookup misses: the evidence files live under the task id, so a
      // task that resolves to nothing has no evidence to inspect.
      return {
        ok: false,
        error: {
          code: "E_NOT_FOUND",
          message: `Task not found: ${input.taskId}`,
        },
      };
    }
  }

  const {
    readEvidence,
    queryStyle,
    diffStyles,
    elementInfo,
    htmlDiff,
    queryHtml,
  } = await import("../../commands/verify-tools.js");
  let ev: EvidenceSet;
  try {
    const loadEvidence = ports.loadEvidence ?? readEvidence;
    ev = await loadEvidence(ctx.projectDir, input.taskId);
  } catch (err) {
    // A present-but-malformed baseline artifact throws out of the loader
    // instead of degrading to nulls: the evidence cannot be trusted, so the
    // query must fail. Same message the renderer printed before; the code
    // names the failure for the envelope.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: { code: "E_EVIDENCE_MALFORMED", message },
    };
  }

  // Dispatch mirrors `runVerifyTool`: tool-level misses travel as DATA
  // (`{ok:false}`), never as refusals, so the renderer prints byte-identical
  // output for every usage error. Only the task resolution and the evidence
  // load above can refuse.
  let result: Record<string, unknown>;
  switch (input.tool) {
    case "style_query": {
      if (!input.property) {
        result = {
          ok: false,
          error: `Usage: vibeflow verify style_query <task-id> <property>`,
        };
        break;
      }
      result = queryStyle(ev, input.property) as Record<string, unknown>;
      break;
    }
    case "style_diff":
      result = diffStyles(ev, input.filter) as Record<string, unknown>;
      break;
    case "element_info":
      result = elementInfo(ev) as Record<string, unknown>;
      break;
    case "html_diff":
      result = htmlDiff(ev) as Record<string, unknown>;
      break;
    case "html_query": {
      if (
        input.queryType !== "children" &&
        input.queryType !== "text" &&
        input.queryType !== "attributes"
      ) {
        result = {
          ok: false,
          error: `Usage: vibeflow verify html_query <task-id> children|text|attributes`,
        };
        break;
      }
      result = queryHtml(
        ev,
        input.queryType as "children" | "text" | "attributes",
      ) as Record<string, unknown>;
      break;
    }
    default:
      result = { ok: false, error: `Unknown tool: ${input.tool}` };
      break;
  }
  return { ok: true, data: result };
}
