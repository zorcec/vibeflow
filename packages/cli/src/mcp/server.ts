/**
 * MCP Server Factory
 *
 * Creates an McpServer instance with all 13 tools registered.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OperationContext, OperationResult } from "../core/operations.js";
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
 * The key is `notices`, NOT `steps`: the CLI has emitted `notices:
 * [{code, message}]` on its own `--json` payloads for a while, and one parser
 * has to read both surfaces. `OperationResult.steps` keeps its internal name —
 * only the wire key changed. (`PushResult` carried a second, nested `steps`
 * string array on the push_tasks payload; that is gone too, so no path emits
 * a bare string or a `steps` key.)
 */
function successPayload<T>(result: OperationResult<T>): unknown {
  // `?? null`: a tool may legitimately return void (push() exits with no value
  // on early paths), and an empty board's claim is `ok:true` with no data.
  // JSON.stringify(undefined) is undefined, which violates the MCP TextContent
  // contract (text: string) — null serialises to a valid JSON string.
  const data = result.data ?? null;
  const notices = result.steps ?? [];
  if (notices.length === 0) return data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), notices };
  }
  // Every operation that returns notices returns an object payload (a Task, a
  // TaskComment, a FileInfo, a push result). The branch below is the total
  // case, so a future operation pairing notices with a scalar cannot lose
  // either half on the wire.
  return { data, notices };
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
