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

// ── MCP Surface Classification (G5) ───────────────────────────────────────

/**
 * The REVERSE of `intentionallyNotExposed`: MCP tool input fields with NO CLI
 * flag analogue, keyed `"tool.field"`.
 *
 * G1 above walks the CLI and fails on an unclassified flag — but it only ever
 * looks in one direction. It never asks the opposite question: does every MCP
 * input field correspond to something a CLI user can actually type?
 *
 * That blind spot was not theoretical. `update_task` advertised
 * `cliRef.flags: ["--set-parent", "--no-parent"]` while its real input was a
 * `links` array with destructive whole-set replace semantics, and those two
 * CLI flags were surgical. G1 passed it: both flag names existed. The gate
 * validated spelling and was blind to meaning, which is exactly the class of
 * divergence an MCP client cannot discover by reading the docs.
 *
 * That one divergence is now closed — `links` merges like --relates/--blocks,
 * and `clearLinks` is the only destructive field — but the gate stays,
 * because the class of bug is not gone.
 *
 * So this list is the auditable record of every place the two surfaces are
 * genuinely not 1-1. Keep it SHORT and honest: an entry here is a claim that
 * the asymmetry is deliberate and understood, and G5 fails on a stale entry
 * exactly as G1 fails on a stale flag exemption. A field that appears here
 * without a real reason is worse than a field that is missing, because it
 * looks reviewed.
 *
 * Structural cases are handled by the G5 test itself rather than listed here
 * (a tool's `id` field matching its command's positional task-id argument, and
 * `dryRun`, which every mutating tool exposes on purpose). Only real
 * capability differences belong in this list.
 */
export const mcpOnlyFields: Record<string, string> = {
  // ── Link mutation ───────────────────────────────────────────────────────
  // This is the divergence that started all of it, and it is now closed on
  // BOTH sides. No MCP field deletes a link any more: `links` and `addLinks`
  // merge, `removeLinks` drops named pairs, and the only whole-set removal is
  // `clearLinks: true` — which is precisely why it is a separately named
  // boolean and not an empty array, since an empty array is what a client
  // sends by accident.
  //
  // What still differs is field SHAPE, not capability: MCP takes arrays where
  // the CLI takes repeatable flags (--relates/--blocks, --unrelates/--unblocks,
  // --set-parent). That is the same difference as create_task.tags vs --tag.
  "update_task.links":
    "merge. Links you do not name are preserved, so this is the same semantic as --relates/--blocks; MCP-only in field SHAPE (one array vs two repeatable flags), exactly like create_task.tags vs `tasks --tag`.",
  "update_task.addLinks":
    "additive merge. The CLI equivalent is --relates/--blocks, both applied through buildAddLinks, so this is MCP-only only in field NAME (one array vs two repeatable flags), not in capability.",
  "update_task.removeLinks":
    "removes exactly the named taskId+type pairs. The CLI equivalent is --unrelates/--unblocks, both applied through buildRemoveLinks, so this is MCP-only in field NAME, not in capability.",
  // The one place the two surfaces deliberately do NOT agree: every CLI link
  // flag preserves what it does not name, so there is no flag that can drop the
  // whole set. Making the MCP destructive path a named boolean keeps a client
  // from reaching data loss by sending an empty array.
  "update_task.clearLinks":
    "the ONLY way to remove links wholesale, and MCP-only by design. No CLI flag clears the whole set — every --set-parent/--relates/--blocks/--unrelates/--unblocks preserves the links it does not name — so the destructive path is an explicitly named boolean rather than an empty array a client could send by accident. To drop one link, name it in removeLinks instead.",

  // ── Annotated-task fields ──────────────────────────────────────────────
  // An annotated task (url + selector) is the whole point of the overlay. The
  // CLI's `--add` could NOT express it at all, so an annotated task was only
  // creatable over MCP — the terminal could not do the product's central thing.
  // `--url`, `--selector` and `--sort-key` were added to `--add` to close that;
  // these entries remain because the MCP FIELDS still have no exact CLI flag
  // counterpart, and the record has to say why rather than silently disappear.
  "create_task.url":
    "URL the annotation targets. `tasks --add --url` now covers this, so the gap is CLOSED; kept because the field name and the flag name differ only by the `--` prefix and G5 needs the mapping stated rather than inferred. Symmetric with create_task.selector.",
  "create_task.selector":
    "CSS selector of the annotated element. `tasks --add --selector` now covers this, so the gap is CLOSED. Paired with create_task.url to record an annotated task.",
  "create_task.cssSelector":
    "alias of create_task.selector kept for clients that prefer the explicit name; both write the same field. The CLI exposes the plain `--selector` name only.",
  "create_task.sortKey":
    "explicit board ordering key. `tasks --add` auto-assigns one; `--sort-key` now allows an override, so the gap is CLOSED.",

  // ── create_task.tags: array-vs-repeatable-flag difference ────────────────
  // The CLI does have --tag, but it is repeatable-for-AND. MCP takes the whole
  // array in one field, so the CLI flag is listed in create_task.cliRef and the
  // field itself is the array form of it. Recorded so the difference is
  // deliberate rather than an oversight.
  "create_task.tags":
    "array form of `tasks --tag` (repeatable, AND-matching). The flag is in cliRef; the field is its single-call array equivalent.",

  // ── Wire-level shape differences, not capability gaps ───────────────────
  "add_comment.author":
    "optional author override. The CLI always derives the author from git config, so a client that wants a specific author can only do so over MCP.",
  "attach_file.filename":
    "target filename. The CLI takes a path on disk via --report-file and reads the file itself; MCP takes the bytes and the name, because a client may not share a filesystem.",
  "attach_file.contentB64":
    "base64 file content — the same reason as attach_file.filename: an MCP client is frequently not on this machine, so the CLI's read-the-path-from-disk model does not apply.",
  "export_prompt.ids":
    "multi-task export. The CLI's --get resolves a single task, so exporting several at once is MCP-only.",
  "export_prompt.format":
    "output format selector. The CLI has a single fixed prompt format, so the choice is MCP-only.",
  "verify_task.timeoutMs":
    "per-call verification timeout, and the CLI equivalent DOES exist: `vibeflow verify <task-id> --timeout <ms>` bounds one run with the same unit (milliseconds), the same 1000-300000 range and the same 60000 default, through the same AbortSignal the engine already honours. The field is MCP-only in NAME and SHAPE (a camelCase input field with a default vs a `--timeout` flag that also defaults), not in capability. Kept because the dashed form G5 looks for is `--timeout-ms`, which is not a flag anyone types.",
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
        "--url",
        "--selector",
        "--sort-key",
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
      "Update an existing task. Supports status changes, title/description updates, adding comments, and changing the task's links (parent/relates/blocks). Pass setVerify to record your verification verdict: \"pass\" attests the task IS implemented correctly (verified=true, green badge — required for annotated tasks at the review transition, which `vibeflow verify` never sets itself), \"fail\" records that it is NOT implemented correctly (verified=false, amber badge, the review gate rejects it), and \"cannot\" clears the verdict back to absent (no badge) for a task that cannot be assessed here — \"cannot\" REQUIRES verifyReason, which is recorded in the task's activity.\n\nLINKS — everything merges, and `clearLinks` is the only destructive path. `links` and `addLinks` both MERGE: a link you do not name is PRESERVED, and re-sending a link that is already there is a no-op, so neither of them can destroy a link by being incomplete. `removeLinks` removes exactly the taskId+type pairs you name and leaves every other link alone. `clearLinks: true` is the ONLY way to remove links wholesale — to drop a single link, name that taskId+type in `removeLinks` rather than editing `links`. Omitting all four fields leaves links untouched. The CLI's `--set-parent`/`--relates`/`--blocks`/`--unrelates`/`--unblocks` behave the same way (each is surgical and preserves every link it does not name), so the CLI and MCP surfaces now agree on link semantics.",
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
        "--relates",
        "--blocks",
        "--unrelates",
        "--unblocks",
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
      // The CLI form is `tasks --edit <id> --set-status review --report-file <path>`.
      // Naming only --report-file made `id` look like an MCP-only field, which
      // is what G5 caught: the report upload is an EDIT of a named task that
      // moves to review, not a standalone flag.
      flags: ["--edit", "--set-status", "--report-file"],
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
      flags: ["--json", "--url", "--timeout"],
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
