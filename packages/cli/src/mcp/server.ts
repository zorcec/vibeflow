/**
 * MCP Server Factory
 *
 * Creates an McpServer instance with all 11 tools registered.
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

function formatResult<T>(result: OperationResult<T>): {
  content: Array<{ type: "text"; text: string }>;
} {
  if (result.ok) {
    return {
      content: [
        {
          type: "text",
          // `?? null`: a tool may legitimately return void (push() exits
          // with no value on early paths). JSON.stringify(undefined) is
          // undefined, which violates the MCP TextContent contract
          // (text: string) — null serialises to a valid JSON string.
          text: JSON.stringify(result.data ?? null, null, 2),
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
