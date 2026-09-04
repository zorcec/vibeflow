/**
 * MCP Tool Manifest
 *
 * Single source of truth for all MCP tools.
 * Maps CLI commands/flags to MCP tool definitions.
 */
import type { z } from "zod";
import type { OperationContext, OperationResult } from "../core/operations.js";
import {
  ListTasksInput,
  GetTaskInput,
  CreateTaskInput,
  UpdateTaskInput,
  ClaimNextTaskInput,
  AddCommentInput,
  AttachFileInput,
  ExportPromptInput,
  VerifyTaskInput,
  PushTasksInput,
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
} from "../core/operations.js";

// ── Manifest Types ─────────────────────────────────────────────────────────

export interface ToolManifest {
  name: string;
  title: string;
  description: string;
  cliRef: {
    command: string;
    flags: string[];
  };
  category: "task-read" | "task-write" | "task-mutate" | "admin";
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  input: z.ZodType;
  run: (
    ctx: OperationContext,
    input: unknown,
  ) => Promise<OperationResult<unknown>>;
}

// ── Tool Definitions ───────────────────────────────────────────────────────

export const manifest: ToolManifest[] = [
  {
    name: "list_tasks",
    title: "List tasks",
    description:
      "List tasks with optional filters. Returns task list with configurable fields.",
    cliRef: {
      command: "tasks",
      flags: ["--status", "--type", "--user", "--tag", "--limit", "--fields"],
    },
    category: "task-read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: ListTasksInput,
    run: (ctx, input) => listTasks(ctx, input as z.infer<typeof ListTasksInput>),
  },
  {
    name: "get_task",
    title: "Get task",
    description: "Get a single task by ID with full details including comments and files.",
    cliRef: {
      command: "tasks",
      flags: ["--get"],
    },
    category: "task-read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: GetTaskInput,
    run: (ctx, input) => getTask(ctx, input as z.infer<typeof GetTaskInput>),
  },
  {
    name: "create_task",
    title: "Create task",
    description: "Create a new task with title, description, and metadata.",
    cliRef: {
      command: "tasks",
      flags: ["--add", "--title", "--description", "--type", "--priority", "--tag"],
    },
    category: "task-write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: CreateTaskInput,
    run: (ctx, input) => createTask(ctx, input as z.infer<typeof CreateTaskInput>),
  },
  {
    name: "update_task",
    title: "Update task",
    description:
      "Update an existing task. Supports status changes, title/description updates, and adding comments.",
    cliRef: {
      command: "tasks",
      flags: [
        "--edit",
        "--set-status",
        "--title",
        "--description",
        "--branch",
        "--comment",
        "--commit-message",
        "--skip-verify",
      ],
    },
    category: "task-mutate",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: UpdateTaskInput,
    run: (ctx, input) => updateTask(ctx, input as z.infer<typeof UpdateTaskInput>),
  },
  {
    name: "claim_next_task",
    title: "Claim next task",
    description: "Claim the highest-priority todo task and set it to in-progress.",
    cliRef: {
      command: "tasks",
      flags: ["--next", "--type", "--tag"],
    },
    category: "task-mutate",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: ClaimNextTaskInput,
    run: (ctx, input) => claimNextTask(ctx, input as z.infer<typeof ClaimNextTaskInput>),
  },
  {
    name: "add_comment",
    title: "Add comment",
    description: "Add a comment to a task.",
    cliRef: {
      command: "tasks",
      flags: ["--comment"],
    },
    category: "task-write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: AddCommentInput,
    run: (ctx, input) => addComment(ctx, input as z.infer<typeof AddCommentInput>),
  },
  {
    name: "attach_file",
    title: "Attach file",
    description: "Attach a file to a task (content as base64).",
    cliRef: {
      command: "tasks",
      flags: ["--report-file"],
    },
    category: "task-write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: AttachFileInput,
    run: (ctx, input) => attachFile(ctx, input as z.infer<typeof AttachFileInput>),
  },
  {
    name: "export_prompt",
    title: "Export prompt",
    description: "Export task(s) as formatted prompt for LLM consumption.",
    cliRef: {
      command: "tasks",
      flags: ["--get", "--json"],
    },
    category: "task-read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: ExportPromptInput,
    run: (ctx, input) => exportPrompt(ctx, input as z.infer<typeof ExportPromptInput>),
  },
  {
    name: "verify_task",
    title: "Verify task",
    description:
      "Run visual verification on a task. Captures baseline and compares.",
    cliRef: {
      command: "verify",
      flags: ["--json", "--url"],
    },
    category: "task-mutate",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: VerifyTaskInput,
    run: (ctx, input) => verifyTaskOp(ctx, input as z.infer<typeof VerifyTaskInput>),
  },
  {
    name: "push_tasks",
    title: "Push tasks",
    description: "Push local tasks to the SaaS server.",
    cliRef: {
      command: "push",
      flags: ["--workspace", "--keep-local-files"],
    },
    category: "admin",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: PushTasksInput,
    run: (ctx, input) => pushTasks(ctx, input as z.infer<typeof PushTasksInput>),
  },
];
