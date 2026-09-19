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
  input: z.ZodRawShape;
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
      "List tasks with optional filters. Returns task list with configurable fields. ROOT tasks only by default — a task with a parent belongs to that parent, so set children:true to include them. The response's hiddenChildren reports how many matched but were omitted.",
    cliRef: {
      command: "tasks",
      flags: [
        "--status",
        "--type",
        "--user",
        "--tag",
        "--limit",
        "--fields",
        "--children",
      ],
    },
    category: "task-read",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: ListTasksInput.shape,
    run: (ctx, input) =>
      listTasks(ctx, input as z.infer<typeof ListTasksInput>),
  },
  {
    name: "get_task",
    title: "Get task",
    description:
      "Get a single task by ID with full details including comments and files.",
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
    input: GetTaskInput.shape,
    run: (ctx, input) => getTask(ctx, input as z.infer<typeof GetTaskInput>),
  },
  {
    name: "create_task",
    title: "Create task",
    description: "Create a new task with title, description, and metadata.",
    cliRef: {
      command: "tasks",
      flags: [
        "--add",
        "--title",
        "--description",
        "--type",
        "--priority",
        "--tag",
        "--parent",
      ],
    },
    category: "task-write",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: CreateTaskInput.shape,
    run: (ctx, input) =>
      createTask(ctx, input as z.infer<typeof CreateTaskInput>),
  },
  {
    name: "update_task",
    title: "Update task",
    description:
      "Update an existing task. Supports status changes, title/description updates, adding comments, and replacing the task's links (parent/relates/blocks; pass an empty array to clear). Pass setVerify to record your verification verdict: \"pass\" attests the task IS implemented correctly (verified=true, green badge — required for annotated tasks at the review transition, which `vibeflow verify` never sets itself), \"fail\" records that it is NOT implemented correctly (verified=false, amber badge, the review gate rejects it), and \"cannot\" clears the verdict back to absent (no badge) for a task that cannot be assessed here — \"cannot\" REQUIRES verifyReason, which is recorded in the task's activity.",
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
        "--set-verify",
        "--verify-reason",
        "--set-parent",
        "--no-parent",
      ],
    },
    category: "task-mutate",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: UpdateTaskInput.shape,
    run: (ctx, input) =>
      updateTask(ctx, input as z.infer<typeof UpdateTaskInput>),
  },
  {
    name: "claim_next_task",
    title: "Claim next task",
    description:
      "Claim the highest-priority ROOT task in todo and set it to in-progress. Never claims a child: a root is the unit of work, so work through its children after claiming it. Mirrors 'vibeflow tasks --next'.",
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
    input: ClaimNextTaskInput.shape,
    run: (ctx, input) =>
      claimNextTask(ctx, input as z.infer<typeof ClaimNextTaskInput>),
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
    input: AddCommentInput.shape,
    run: (ctx, input) =>
      addComment(ctx, input as z.infer<typeof AddCommentInput>),
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
    input: AttachFileInput.shape,
    run: (ctx, input) =>
      attachFile(ctx, input as z.infer<typeof AttachFileInput>),
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
    input: ExportPromptInput.shape,
    run: (ctx, input) =>
      exportPrompt(ctx, input as z.infer<typeof ExportPromptInput>),
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
    input: VerifyTaskInput.shape,
    run: (ctx, input) =>
      verifyTaskOp(ctx, input as z.infer<typeof VerifyTaskInput>),
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
    input: PushTasksInput.shape,
    run: (ctx, input) =>
      pushTasks(ctx, input as z.infer<typeof PushTasksInput>),
  },
];
