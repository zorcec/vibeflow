/**
 * MCP Server Factory
 *
 * Creates an McpServer instance with all 13 tools registered.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  OperationContext,
  OperationNotice,
  OperationResult,
} from "../core/operations.js";
import { getGitUser } from "../core/git-user.js";
import { getCurrentBranch, getProjectName } from "../core/config.js";
import { resolve } from "node:path";
import { CLI_VERSION } from "../version.js";
import { manifest } from "./manifest.js";

// ── Tool Registration ──────────────────────────────────────────────────────

export function createMcpServer(
  projectDir: string,
  mode: "local" | "saas" = "local",
): McpServer {
  // W2: the handshake names the resolved absolute root — a client can tell
  // which project it is about to mutate from `initialize` alone.
  const abs = resolve(projectDir);
  const branch = getCurrentBranch(abs);
  const server = new McpServer(
    { name: "vibeflow", version: CLI_VERSION },
    {
      instructions: `Project root: ${abs} (name: ${getProjectName(abs)}, branch: ${branch ?? "none"}, mode: ${mode})`,
    },
  );

  const ctx: OperationContext = { projectDir: abs, mode, userId: getGitUser(abs).name };

  for (const tool of manifest) {
    server.tool(
      tool.name,
      tool.description,
      tool.input,
      tool.annotations,
      async (input) => {
        const result = await tool.run(ctx, input);
        return formatResult(result);
      },
    );
  }

  return server;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * The notice codes that mean something DID NOT go the way the operation
 * promised, as opposed to explaining a result that is already fine.
 *
 * `GIT_COMMIT_FAILED` is the whole list today, and it is error-class for a
 * specific reason: the operation's own effect is real and durable (the task
 * file changed) while a SECOND effect the caller implicitly asked for (a git
 * commit) is not. The two halves must not be reported under one `ok`.
 *
 * Everything else the operations layer and push can attach to an ok:true
 * result is informational: `DRY_RUN`, `GIT_COMMITTED`, `PUSH_COMPLETED`,
 * `NOTHING_TO_PUSH`.
 *
 * The classification is an EXPLICIT list and it is closed on the
 * INFORMATIONAL side: an unrecognised code is treated as informational,
 * because `successPayload` adds `committed` only on the error path and a code
 * nobody classified must not start adding a key to every payload. The cost of
 * that choice is that a NEW error-class code has to be added here — the
 * notice codes on the wire are the CLI's own, so this list is the single place
 * that says which of them are worth interrupting a client for.
 */
const ERROR_CLASS_NOTICE_CODES: ReadonlySet<string> = new Set([
  "GIT_COMMIT_FAILED",
]);

/**
 * What `successPayload` puts on the wire: either the operation's own data,
 * untouched (or `null` for a void result), or that data's object shape
 * carrying the notice keys beside it. Named rather than `unknown` so the three
 * shapes a consumer can meet are written down here once — the wire is JSON,
 * and this is the JSON.
 */
type SuccessPayload<T> =
  | T
  | null
  | (Record<string, unknown> & { notices: OperationNotice[] });

/**
 * The success wire payload.
 *
 * A plain read has no notices, so its payload is the operation's data verbatim
 * — the 13 tools' existing success shapes do not churn. An operation that DOES
 * return notices (every dry-run preview, and the review auto-commit report)
 * gets them as a sibling `notices` key on that same object.
 *
 * Two properties this buys, both of which the previous `JSON.stringify(result.
 * data)` lacked:
 *  - a preview is unmistakably a preview: `notices` carries
 *    `{code:"DRY_RUN", message:"Task would be updated"}`, so a client can
 *    never mistake an `attach_file {dryRun:true}` for a write that happened;
 *  - notices are never silently dropped: a review transition whose auto-commit
 *    FAILED still answers ok:true, and `{code:"GIT_COMMIT_FAILED", …}` is the
 *    only signal the client gets that nothing was committed.
 *
 * A THIRD property, and the reason `notices` alone is not enough: notices are
 * not all the same KIND. Most are informational — a `DRY_RUN` preview, a
 * `GIT_COMMITTED` sha, a `PUSH_COMPLETED` report, a `NOTHING_TO_PUSH` note —
 * and each explains a result the caller already has. One is error-class:
 * `GIT_COMMIT_FAILED`, a transition that genuinely succeeded while the commit
 * it triggers failed. A client that reads ONLY the top-level status never
 * learns from that the write is uncommitted, which is the single outcome a
 * task-tracking agent must not walk away from. So an error-class notice ALSO
 * lands a top-level `committed: false`, where a client checking one scalar
 * cannot miss it.
 *
 * WHY `ok` STILL STAYS TRUE, deliberately: the transition really did happen.
 * The task file is written and the task's status changed; only the commit did
 * not. Reporting `ok:false` would misreport a real success as a failure and
 * invite the client to RETRY the transition, re-applying edits that already
 * landed. The failure is reported where the failure lives — `committed:false`
 * plus the existing `GIT_COMMIT_FAILED` notice — never by falsifying the
 * status of a write that succeeded.
 *
 * `committed` is ADDITIVE and ONE-DIRECTIONAL: the key is present ONLY when
 * it is false, and absent otherwise. No payload that is fine today gains a
 * key, so nothing that already parses the success shape has to change; a
 * client that wants the signal tests `payload.committed === false`, and one
 * that has never heard of it is unaffected. Absent means "no error-class
 * notice" — which covers the committed case AND the preview case, since
 * `DRY_RUN` is informational.
 *
 * The key is `notices`, NOT `steps`: the CLI has emitted `notices:
 * [{code, message}]` on its own `--json` payloads for a while, and one parser
 * has to read both surfaces. `OperationResult.steps` keeps its internal name —
 * only the wire key changed. (`PushResult` carried a second, nested `steps`
 * string array on the push_tasks payload; that is gone too, so no path emits
 * a bare string or a `steps` key.)
 */
function successPayload<T>(result: OperationResult<T>): SuccessPayload<T> {
  // `?? null`: a tool may legitimately return void (push() exits with no value
  // on early paths), and an empty board's claim is `ok:true` with no data.
  // JSON.stringify(undefined) is undefined, which violates the MCP TextContent
  // contract (text: string) — null serialises to a valid JSON string.
  const data = result.data ?? null;
  const notices = result.steps ?? [];
  if (notices.length === 0) return data;
  // `{}` vs `{committed:false}` rather than an always-present `committed`:
  // the error path is the only one that changes a payload shape, so a
  // clean success and a preview stay byte-identical to what they were.
  const uncommitted = notices.some((n) =>
    ERROR_CLASS_NOTICE_CODES.has(n.code),
  )
    ? { committed: false as const }
    : {};
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), notices, ...uncommitted };
  }
  // Every operation that returns notices returns an object payload (a Task, a
  // TaskComment, a FileInfo, a push result). The branch below is the total
  // case, so a future operation pairing notices with a scalar cannot lose
  // either half on the wire — nor the `committed` signal, which travels with
  // the notices rather than with the payload's own shape.
  return { data, notices, ...uncommitted };
}

function formatResult<T>(result: OperationResult<T>): {
  content: Array<{ type: "text"; text: string }>;
} {
  if (result.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(successPayload(result), null, 2),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        // Same envelope the CLI's --json contract emits (see
        // outputEnvelope in src/index.ts): {ok:false, error:{code, message,
        // retryable, suggestion?}}. A machine consumer must be able to parse
        // an MCP refusal exactly as it parses a CLI one; the previous flat
        // {error, message, suggestion} forced every client to special-case
        // this surface. `retryable` is defaulted so the shape is stable even
        // when the operation did not set it.
        text: JSON.stringify(
          {
            ok: false,
            error: {
              code: result.error?.code ?? "UNKNOWN_ERROR",
              message:
                result.error?.message ?? "An unknown error occurred",
              retryable: result.error?.retryable ?? false,
              ...(result.error?.suggestion
                ? { suggestion: result.error.suggestion }
                : {}),
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}
