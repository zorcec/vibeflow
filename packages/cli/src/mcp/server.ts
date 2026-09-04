/**
 * MCP Server Factory
 *
 * Creates an McpServer instance with all 10 tools registered.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  claimNextTask,
  addComment,
  attachFile,
  exportPrompt,
  verifyTaskOp,
  pushTasks,
  type OperationContext,
  type OperationResult,
} from "../core/operations.js";
import { z } from "zod";

// ── Tool Registration ──────────────────────────────────────────────────────

export function createMcpServer(
  projectDir: string,
  mode: "local" | "saas" = "local",
): McpServer {
  const server = new McpServer({
    name: "vibeflow",
    version: "0.1.0",
  });

  const ctx: OperationContext = { projectDir, mode };

  // ── list_tasks ─────────────────────────────────────────────────────
  server.tool(
    "list_tasks",
    "List tasks with optional filters. Returns task list with configurable fields.",
    {
      status: z
        .enum(["backlog", "todo", "in-progress", "review", "done"])
        .optional()
        .describe("Filter by task status"),
      type: z
        .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
        .optional()
        .describe("Filter by task type"),
      user: z.string().optional().describe("Filter by task author"),
      tag: z
        .array(z.string())
        .optional()
        .describe("Filter by tags (AND logic)"),
      limit: z
        .number()
        .min(0)
        .default(5)
        .describe("Maximum number of tasks to return (0 = unlimited)"),
      fields: z
        .array(z.string())
        .optional()
        .describe("Specific fields to return"),
    },
    async (input) => {
      const result = await listTasks(ctx, input);
      return formatResult(result);
    },
  );

  // ── get_task ───────────────────────────────────────────────────────
  server.tool(
    "get_task",
    "Get a single task by ID with full details including comments and files.",
    {
      id: z.string().min(1).describe("Task ID (full or prefix)"),
      fields: z
        .array(z.string())
        .optional()
        .describe("Specific fields to return"),
    },
    async (input) => {
      const result = await getTask(ctx, input);
      return formatResult(result);
    },
  );

  // ── create_task ────────────────────────────────────────────────────
  server.tool(
    "create_task",
    "Create a new task with title, description, and metadata.",
    {
      title: z.string().min(1).describe("Task title"),
      description: z.string().optional().describe("Task description"),
      status: z
        .enum(["backlog", "todo", "in-progress", "review", "done"])
        .default("todo")
        .describe("Initial task status"),
      type: z
        .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
        .default("Task")
        .describe("Task type"),
      priority: z
        .enum(["Critical", "High", "Medium", "Low"])
        .default("Medium")
        .describe("Task priority"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      url: z.string().optional().describe("URL of the annotated page"),
      selector: z
        .string()
        .default("/")
        .describe("CSS selector of annotated element"),
      cssSelector: z
        .string()
        .optional()
        .describe("CSS selector for the element"),
    },
    async (input) => {
      const result = await createTask(ctx, input);
      return formatResult(result);
    },
  );

  // ── update_task ────────────────────────────────────────────────────
  server.tool(
    "update_task",
    "Update an existing task. Supports status changes, title/description updates, and adding comments.",
    {
      id: z.string().min(1).describe("Task ID"),
      status: z
        .enum(["backlog", "todo", "in-progress", "review", "done"])
        .optional()
        .describe("New task status"),
      title: z.string().min(1).optional().describe("New task title"),
      description: z.string().optional().describe("New task description"),
      branch: z.string().optional().describe("Git branch name"),
      comment: z.string().optional().describe("Add a comment to the task"),
      commitMessage: z.string().optional().describe("Git commit message"),
      skipVerify: z
        .boolean()
        .default(false)
        .describe("Skip verify gate when setting status to review"),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Preview changes without applying"),
    },
    async (input) => {
      const result = await updateTask(ctx, input);
      return formatResult(result);
    },
  );

  // ── claim_next_task ────────────────────────────────────────────────
  server.tool(
    "claim_next_task",
    "Claim the highest-priority todo task and set it to in-progress.",
    {
      type: z
        .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
        .optional()
        .describe("Filter by task type"),
      user: z.string().optional().describe("Claim for specific user"),
      tag: z
        .array(z.string())
        .optional()
        .describe("Filter by tags (AND logic)"),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Preview which task would be claimed"),
    },
    async (input) => {
      const result = await claimNextTask(ctx, input);
      return formatResult(result);
    },
  );

  // ── add_comment ────────────────────────────────────────────────────
  server.tool(
    "add_comment",
    "Add a comment to a task.",
    {
      id: z.string().min(1).describe("Task ID"),
      text: z.string().min(1).describe("Comment text"),
      author: z
        .enum(["agent", "user"])
        .default("agent")
        .describe("Comment author"),
    },
    async (input) => {
      const result = await addComment(ctx, input);
      return formatResult(result);
    },
  );

  // ── attach_file ────────────────────────────────────────────────────
  server.tool(
    "attach_file",
    "Attach a file to a task (content as base64).",
    {
      id: z.string().min(1).describe("Task ID"),
      filename: z.string().min(1).describe("Filename"),
      contentB64: z
        .string()
        .min(1)
        .describe("File content as base64-encoded string"),
    },
    async (input) => {
      const result = await attachFile(ctx, input);
      return formatResult(result);
    },
  );

  // ── export_prompt ──────────────────────────────────────────────────
  server.tool(
    "export_prompt",
    "Export task(s) as formatted prompt for LLM consumption.",
    {
      id: z.string().optional().describe("Single task ID to export"),
      ids: z
        .array(z.string())
        .optional()
        .describe("Multiple task IDs to export"),
      format: z
        .enum(["markdown", "json"])
        .default("markdown")
        .describe("Output format"),
    },
    async (input) => {
      const result = await exportPrompt(ctx, input);
      return formatResult(result);
    },
  );

  // ── verify_task ────────────────────────────────────────────────────
  server.tool(
    "verify_task",
    "Run visual verification on a task. Captures baseline and compares.",
    {
      id: z.string().min(1).describe("Task ID"),
      url: z.string().url().optional().describe("URL to verify against"),
      timeoutMs: z
        .number()
        .min(1000)
        .max(300000)
        .default(60000)
        .describe("Timeout in milliseconds"),
    },
    async (input) => {
      const result = await verifyTaskOp(ctx, input);
      return formatResult(result);
    },
  );

  // ── push_tasks ─────────────────────────────────────────────────────
  server.tool(
    "push_tasks",
    "Push local tasks to the SaaS server.",
    {
      workspace: z.string().optional().describe("Target workspace ID"),
      keepLocalFiles: z
        .boolean()
        .default(true)
        .describe("Keep local task files after push"),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Preview push without executing"),
    },
    async (input) => {
      const result = await pushTasks(ctx, input);
      return formatResult(result);
    },
  );

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
