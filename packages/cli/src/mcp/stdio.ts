/**
 * MCP stdio transport (model1-mcp plan §W4).
 *
 * An MCP client (Claude Desktop, Cursor, …) spawns `vibeflow mcp --project
 * <dir>` once per project. stdin/stdout are the JSON-RPC channel, so stdout
 * must carry protocol frames ONLY — every human-facing line (the project-root
 * announcement, refusals, notices) belongs on stderr, at the CLI boundary in
 * `src/index.ts`, never in this module.
 *
 * Clean exit: when the client closes stdin the transport's close handler
 * ends the process, so a detached or crashing client never leaves a spawned
 * server behind.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

export async function runStdioMcp(
  projectDir: string,
  mode: "local" | "saas",
): Promise<void> {
  const server = createMcpServer(projectDir, mode);
  const transport = new StdioServerTransport();
  // stdin EOF (client closed us) → the transport closes; exit explicitly so
  // no lingering handle keeps a spawned per-project process alive.
  transport.onclose = () => {
    process.exit(0);
  };
  await server.connect(transport);
}
