/**
 * MCP server surface re-export (P4a decision (B)).
 *
 * `@vibeflow-tools/api-core` pins the zod generation the tool schemas in
 * `./mcp-tools.js` are built with (`zod ^4`). The MCP SDK peer-resolves
 * `zod` from the importing package's graph, so importing the SDK straight
 * from an app whose own zod is v3 pairs v4-built schemas with v3-paired
 * SDK helpers — a type- AND runtime-version mix (structurally different
 * `$ZodType` generations; the SDK wraps v4 fields in its paired zod's
 * mini-object). Importing the SDK through THIS module instead pairs it
 * with the same v4 the schemas use, on both surfaces. Always import MCP
 * server classes from here, never from the SDK package directly.
 */
export { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export {
  WebStandardStreamableHTTPServerTransport,
  type WebStandardStreamableHTTPServerTransportOptions,
  type HandleRequestOptions,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
export type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
