/**
 * MCP Server Factory
 *
 * Creates an McpServer instance with all 10 tools registered.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OperationContext, OperationResult } from "../core/operations.js";
import { getGitUser } from "../core/git-user.js";
import { manifest } from "./manifest.js";

// ── Tool Registration ──────────────────────────────────────────────────────

export function createMcpServer(
  projectDir: string,
  mode: "local" | "saas" = "local",
): McpServer {
  const server = new McpServer({
    name: "vibeflow",
    version: "0.1.0",
  });

  const ctx: OperationContext = { projectDir, mode, userId: getGitUser(projectDir).name };

  for (const tool of manifest) {
    server.tool(tool.name, tool.description, tool.input, async (input) => {
      const result = await tool.run(ctx, input);
      return formatResult(result);
    });
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
          text: JSON.stringify(result.data, null, 2),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: result.error?.code ?? "UNKNOWN_ERROR",
            message: result.error?.message ?? "An unknown error occurred",
            suggestion: result.error?.suggestion,
          },
          null,
          2,
        ),
      },
    ],
  };
}
