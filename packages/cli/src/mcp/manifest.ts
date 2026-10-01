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
  GetProjectInput,
  CreateTaskInput,
  UpdateTaskInput,
  ClaimNextTaskInput,
  AddCommentInput,
  AttachFileInput,
  ExportPromptInput,
  VerifyTaskInput,
  PushTasksInput,
  StartKanbanInput,
  GetIntegrationGuideInput,
  listTasks,
  getTask,
  getProject,
  createTask,
  updateTask,
  claimNextTask,
  addComment,
  attachFile,
  exportPrompt,
  verifyTaskOp,
  pushTasks,
  startKanban,
  getIntegrationGuide,
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
  category:
    | "task-read"
    | "task-write"
    | "task-mutate"
    | "admin"
    | "server";
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

// ── CLI Surface Classification (G1) ──────────────────────────────────────

/**
 * Deliberately-unexposed CLI surface. G1 (tests/unit/mcp/drift.test.ts)
 * fails the build when any commander option is neither owned by a manifest
 * `cliRef` nor listed here with an auditable reason.
 */
export interface CliSurfaceClassification {
  /** Commands with NO mapped tool (whole command is deliberately unexposed). */
  commands: Record<string, string>;
  /** Individual flags of partially-exposed commands, keyed "command --flag". */
  flags: Record<string, string>;
}

export const intentionallyNotExposed: CliSurfaceClassification = {
  commands: {
    auth: "manages encrypted per-task Playwright auth-state files; a local security utility, not a task operation",
    changelog: "prints the packed changelog; no task state",
    kanban: "only the board SERVER is exposed, as start_kanban/get_integration_guide; the browser-opening and changelog side of the command are not reachable over MCP",
    login: "interactive device-flow authentication; hidden; cannot be driven non-interactively over MCP",
    logout: "clears the local auth token; hidden; local credential mutation",
    mcp: "stdio transport entry — spawned per project by an MCP client; not a task operation",
    serve: "long-running prototype/API server; the board server itself is reachable via start_kanban, but the HTML-target viewer mode is not an MCP operation",
    telemetry: "local telemetry opt-in/opt-out config; not a task operation",
    watch: "long-running task-store event daemon / JSONL stream; not an operation",
  },
  flags: {
    "tasks --commit":
      "commits staged paths and links the SHA to a task — a local git workflow; update_task covers the review auto-commit path",
    "tasks --task": "task selector for --commit only; not an operation on its own",
    "tasks --message":
      "commit message for --commit only; update_task uses commitMessage at review",
    "tasks --dry-run":
      "CLI preview flag; every mutating tool exposes a `dryRun` input instead",
    "tasks --reindex-sort-keys":
      "one-time board-ordering maintenance; idempotent re-key, no MCP equivalent",
    "verify --filter":
      "style_diff filter used only by `vibeflow verify style_diff`; verify_task exposes only id/url/timeoutMs/dryRun",
  },
};

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
    name: "get_project",
    title: "Get project",
    description:
      "Return the resolved project this server is attached to: name, absolute root, git branch and mode. Read-only; takes no input.",
    cliRef: { command: "status", flags: [] },
    category: "admin",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: GetProjectInput.shape,
    run: (ctx, input) => getProject(ctx, input as z.infer<typeof GetProjectInput>),
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
      "Update an existing task. Supports status changes, title/description updates, adding comments, and changing the task's links (parent/relates/blocks). Pass setVerify to record your verification verdict: \"pass\" attests the task IS implemented correctly (verified=true, green badge — required for annotated tasks at the review transition, which `vibeflow verify` never sets itself), \"fail\" records that it is NOT implemented correctly (verified=false, amber badge, the review gate rejects it), and \"cannot\" clears the verdict back to absent (no badge) for a task that cannot be assessed here — \"cannot\" REQUIRES verifyReason, which is recorded in the task's activity.\n\nLINKS — three styles, and picking the wrong one deletes data. `addLinks`/`removeLinks` change links additively and leave every other link alone: use these unless you mean to rewrite the whole set. `links` REPLACES the entire link set (HTTP PATCH parity) — any link you omit from that array is DELETED, and an empty array clears every link. Omitting all three leaves links untouched. `links` cannot be combined with `addLinks`/`removeLinks`; that call is refused rather than guessed. The CLI's `--set-parent`/`--no-parent` behave like `addLinks`/`removeLinks` (surgical), so they are the closer analogue for incremental edits.",
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
      "Claim the highest-priority ROOT task in todo and set it to in-progress. Never claims a child: a root is the unit of work, so work through its children after claiming it. Mirrors 'vibeflow tasks --next'. An empty board is a SUCCESS, not a failure: the result is then `null` (an object means a task was claimed, `null` means there was nothing to claim), the same as 'vibeflow tasks --next --json' reporting `task:null` with exit 0. A valid filter that matches no task is the same situation and gives the same `null`.",
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
    description: "Add a comment to a task. The body is `comment` — the same name as the CLI's --comment flag and update_task's field.",
    cliRef: {
      command: "tasks",
      // The only form that writes a comment is `tasks --edit <id> --comment`;
      // the bare `tasks --comment` form is rejected with E_USAGE (index.ts),
      // so naming only --comment here would point at a no-op.
      flags: ["--edit", "--comment"],
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
    // The .md/Research role is stated HERE because this description is what a
    // client reads: it is the only place a refused agent learns that
    // attach_file is the recovery path for RESEARCH_REPORT_REQUIRED.
    description:
      "Attach a file to a task (content as base64). A filename ending in `.md` is what satisfies the research-report gate: a `type:\"Research\"` task is refused review with RESEARCH_REPORT_REQUIRED until a `.md` is attached, so attaching the report is how to recover from that refusal.",
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
      flags: ["--workspace", "--keep-local-files", "--dry-run"],
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
  {
    name: "start_kanban",
    title: "Start kanban server",
    description:
      "Start the local kanban board server and return the instruction block the CLI prints: the kanban URL, the localhost URL when bound to 0.0.0.0, the agent prompt, and the overlay integration guide. IDEMPOTENT — one server per process; a second call returns the running instance (alreadyRunning:true) instead of fighting for the port. Call it once before get_integration_guide so the guide carries real URLs.",
    cliRef: {
      command: "kanban",
      flags: ["--port", "--host"],
    },
    category: "server",
    annotations: {
      // Binds a port and starts a process, so it is not a read...
      readOnlyHint: false,
      destructiveHint: false,
      // ...and the singleton makes a repeat call safe.
      idempotentHint: true,
      // Exposes an HTTP server on this machine.
      openWorldHint: true,
    },
    input: StartKanbanInput.shape,
    run: (ctx, input) =>
      startKanban(ctx, input as z.infer<typeof StartKanbanInput>),
  },
  {
    name: "get_integration_guide",
    title: "Get integration guide",
    description:
      "Get the overlay/bookmarklet integration instructions — the text of the /inject page: the script tag to paste, the browser-console snippet, the bookmarklet, and the /inject URL. Works whether or not the server is running; when it is not, the guide is built against the default port and the result says serverRunning:false, so call start_kanban first for real URLs.",
    cliRef: {
      command: "kanban",
      flags: [],
    },
    category: "server",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: GetIntegrationGuideInput.shape,
    run: (ctx, input) =>
      getIntegrationGuide(ctx, input as z.infer<typeof GetIntegrationGuideInput>),
  },
];
