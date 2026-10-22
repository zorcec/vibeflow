/**
 * MCP tool definitions — the contract half of the tool layer (P4a decision (B)).
 *
 * Canonical home of the pure, runtime-agnostic tool surface: task/link
 * vocabulary, the twelve zod input schemas, and the tool declarations
 * (name, title, description, cliRef, category, annotations, input).
 * Both surfaces consume THIS module: the local CLI attaches its
 * file-backed `run` functions in `packages/cli/src/mcp/manifest.ts`
 * (which stays the single wiring point the drift gates assert on), and
 * the hosted cloud surface registers the same declarations with its
 * DB-backed runners. No filesystem, no processes, no network — importing
 * this module must never pull in anything beyond `zod`.
 */
import { z } from "zod";

// ── Task/link vocabulary (moved from CLI core/types.ts, P4a) ───────────────
// The CLI re-exports these from `core/types.ts`, so existing importers do
// not churn; this module is the single spelling.
export const TASK_LINK_TYPES = ["parent", "relates", "blocks"] as const;
export type TaskLinkType = (typeof TASK_LINK_TYPES)[number];

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// ── DEFAULT_LIST_LIMIT: the ONE agent-facing default page size ────────────────
// WHAT: every list surface with a silent default (the MCP `limit` schema
//   default below, the CLI `--limit` default in packages/cli/src/index.ts
//   via resolveListLimit in packages/cli/src/core/task-listing.ts) resolves
//   to THIS constant. A future change to the number changes both surfaces by
//   construction — the drift test in
//   packages/cli/tests/unit/task-listing-limits.test.ts pins that.
// WHY 20 (measured, not guessed — DB review payload: 1,812,492 bytes for
//   500 tasks ≈ 3.6 KB ≈ ~900 tokens per task, ESTIMATED):
//   - 5 is too small: it under-answers the common call ("list my todo
//     tasks"), so the agent re-calls and spends MORE than the small default
//     saved. The previous 5 had NO documented rationale at all — the schema
//     description explained negative values but never the number. That is
//     what this job fixes.
//   - 20 ≈ 18k tokens covers a realistic filtered working set at roughly 9%
//     of a 200k context: the sweet spot for an AGENT-facing default.
//   - 50 ≈ 45k / 100 ≈ 90k / 500 ≈ 450k tokens are fine for a human CLI or
//     for v0 REST (which pages, so the cost is opt-in), but wrong as a
//     silent agent default.
// WHY v0 REST STAYS AT 100 and is deliberately NOT unified: cursor paging
//   makes a large page safe and cheap there (the caller pays per page,
//   opt-in), while an MCP caller pays in context on EVERY call and must not
//   be forced to walk pages to see a working set.
// WHO + WHEN: listing-limits lane, 2026-10-17. TICKET: 9bb350a7.
// IMPACT: every MCP list_tasks call without an explicit limit now returns
//   up to 20 rows instead of 5; position fields (offset/remaining/nextCursor/
//   order) ride on TaskListResult in core/task-listing.ts.
export const DEFAULT_LIST_LIMIT = 20;

// ── Input schemas (moved from CLI core/operations.ts, P4a) ────────────────
// Re-exported from `core/operations.ts` for the same reason as above.
export const ListTasksInput = z.object({
  // SAFETY: TASK_STATUSES is canonical; z.enum needs mutable tuple
  status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).optional().describe(
    "Exact status match (backlog, todo, in-progress, review, done). Combines with the other filters: every given filter must match.",
  ),
  type: z
    .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
    .optional()
    .describe(
      "Task type, matched case-insensitively (a task with no type counts as Task). Combines with the other filters.",
    ),
  user: z.string().optional().describe(
    "Assignee match, trimmed and case-insensitive. Combines with the other filters.",
  ),
  tag: z.array(z.string()).optional().describe(
    "Every listed tag must be present on the task (AND, not OR). Combines with the other filters.",
  ),
  // DESCRIBED, not just typed: `tools/list` is the ONLY place a client can
  // read this before the SDK's input validation refuses the call with
  // `MCP error -32602: … at limit`, which is raised before any handler runs and
  // carries no `suggestion`. See the field-description note below.
  limit: z
    .number()
    .min(0)
    .default(DEFAULT_LIST_LIMIT)
    .describe(
      "How many tasks to return (default 20). 0 is NOT supported and is resolved to the default LOUDLY — the response echoes the resolved limit and names the fallback in `limitNotice` — so never pass 0 meaning \"all\": there is no unbounded mode. A negative value is refused by input validation before the tool runs. Cost of asking for everything: roughly ~900 tokens per task, so a 500-task board costs ~450k context tokens — keep the default page and continue via offset/remaining/nextCursor (CLI: --all pages for you).",
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "Return only these task fields per row (e.g. [\"id\",\"title\",\"status\"]) to save context. Omit for the full task objects. Projected rows ALWAYS carry commentCount/fileCount even when the comments/files arrays are omitted, so a projection never silently hides that discussion or attachments exist.",
    ),
  /**
   * Include child tasks in the UNFILTERED listing. Default false: only ROOT
   * tasks are listed, matching the board, where a child is rendered inside
   * its parent's card rather than as a peer. See `isChildTask` in ./tasks.js.
   * A FILTERED query (status/type/user/tag) is an explicit search and ALWAYS
   * includes matching children — exactly like `vibeflow tasks --status todo`
   * — so no match is ever hidden because its parent did not match.
   */
  children: z.boolean().default(false).describe(
    "Include child tasks in an UNFILTERED listing (default false: roots only, matching the board). A filtered query always includes matching children, so this flag only matters when no status/type/user/tag filter is given.",
  ),
});
export type ListTasksInputType = z.infer<typeof ListTasksInput>;

export const GetTaskInput = z.object({
  // Descriptions are load-bearing on the fields agents most often get wrong:
  // see ListTasksInput.limit for why `tools/list` is the only place they can be
  // read before the SDK refuses the call.
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one. Get a real id from list_tasks; an id that matches nothing is refused with TASK_NOT_FOUND.",
    ),
  fields: z.array(z.string()).optional().describe(
    "Return only these task fields (e.g. [\"id\",\"title\",\"status\"]) instead of the full task with comments and files. Omit for full details.",
  ),
});
export type GetTaskInputType = z.infer<typeof GetTaskInput>;

// No input by design: the project root is resolved once at server startup
// (ctx.projectDir) and is never a per-call parameter — see getProject below.
export const GetProjectInput = z.object({});
export type GetProjectInputType = z.infer<typeof GetProjectInput>;

export const CreateTaskInput = z.object({
  title: z.string().min(1).describe("Task title — the only required field."),
  description: z.string().optional().describe(
    "Longer task body (what to do, acceptance criteria). Optional; omit when the title says it all.",
  ),
  // SAFETY: TASK_STATUSES is a readonly tuple; z.enum requires a mutable tuple type.
  status: z
    .enum(TASK_STATUSES as unknown as [string, ...string[]])
    .default("todo")
    .describe("Initial status. Defaults to todo; pass another status only to create the task already in motion."),
  type: z
    .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
    .default("Task")
    .describe(
      'Task type. Defaults to Task; use Research for an investigation (it reaches review on its attached .md report, with no verification verdict).',
    ),
  priority: z.enum(["Critical", "High", "Medium", "Low"]).default("Medium").describe(
    "Priority tier, driving claim order (Critical first). Defaults to Medium.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags for filtering (list_tasks --tag matches every listed tag). Omit for untagged.",
  ),
  url: z.string().optional().describe(
    "URL the annotation targets. Together with selector this makes the task annotated (overlay-verifiable); omit both for a plain task.",
  ),
  selector: z.string().default("/").describe(
    "CSS selector of the annotated element (default \"/\", meaning the whole page). Only meaningful with url.",
  ),
  cssSelector: z.string().optional().describe(
    "Alias of selector for clients that prefer the explicit name; both write the same field.",
  ),
  // Optional explicit ordering key; core auto-assigns one when omitted.
  sortKey: z.string().optional().describe(
    "Explicit board ordering key. Omit it — core auto-assigns one — unless you must place the task exactly.",
  ),
  // Optional parent task id (full id or unique prefix); links the new task
  // under it as a child.
  parent: z.string().min(1).optional().describe(
    "Parent task id (full id or unique prefix) to create this task as a child. Omit for a root task; merges with links as one union when both are given.",
  ),
  // MERGE semantics, identical to `update_task`'s `links` and to the CLI's
  // `--relates` / `--blocks`: every listed pair is ADDED to the new task,
  // and `parent` (when given) is folded into the same set, so sending both
  // merges their union once — a pair named twice is a no-op, never a
  // duplicate-parent refusal. A brand-new task has no links yet, so there
  // is nothing to preserve; merge still matters because it is what makes
  // `parent` + `links` composable instead of mutually exclusive.
  // `links: []` is refused (E_USAGE) rather than read as "no links": the
  // same trap `update_task` closes — under merge an empty array names no
  // links, and silently doing nothing would hide a client that still assumes
  // replace semantics. Omit the field entirely for no links.
  links: z
    .array(
      z.object({
        taskId: z.string().min(1),
        // SAFETY: TASK_LINK_TYPES is a readonly tuple; z.enum requires a mutable tuple type.
        type: z.enum(
          TASK_LINK_TYPES as unknown as [TaskLinkType, ...TaskLinkType[]],
        ),
      }),
    )
    .optional()
    .describe(
      "ADD the listed links to the new task (merge, same as update_task's `links`). Combined with `parent` as a union; a pair named twice is a no-op. `links: []` is REFUSED — omit the field for no links.",
    ),
  // Preview only — never writes a task file. Present so the manifest's claim
  // that every mutating tool exposes `dryRun` is true for create_task too.
  dryRun: z.boolean().default(false).describe(
    "Preview only: validate the input and report what WOULD be created without writing a task file.",
  ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "Return only these task fields (e.g. [\"id\",\"title\",\"status\"]) instead of the full task object. Omit for the full object — same selector list_tasks and get_task take.",
    ),
});
export type CreateTaskInputType = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one, of the task to update. An id that matches nothing is refused with TASK_NOT_FOUND and changes nothing.",
    ),
  // SAFETY: TASK_STATUSES is a readonly tuple; z.enum requires a mutable tuple type.
  status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).optional().describe(
    "New status. Moving to review triggers the review gate (comment, and for annotated tasks a verdict, may be required).",
  ),
  title: z.string().min(1).optional().describe("Replacement title. Omit to keep the current one."),
  description: z.string().optional().describe("Replacement task body. Omit to keep the current one."),
  branch: z.string().optional().describe(
    "Branch for this task's work. REQUIRED on the review transition when the project sets createBranch (refused BRANCH_REQUIRED); stored as branchName.",
  ),
  comment: z
    .string()
    .optional()
    .describe(
      "Comment to attach (same as the CLI's --comment). REQUIRED when status is \"review\" — the review transition is refused with REVIEW_COMMENT_REQUIRED without one.",
    ),
  commitMessage: z
    .string()
    .optional()
    .describe(
      "Commit message for the review auto-commit (same as the CLI's --commit-message). REQUIRED when status is \"review\" and auto-commit is ON (refused with COMMIT_MESSAGE_REQUIRED); ignored when auto-commit is off.",
    ),
  // Set/replace the parent link (same as the CLI's --set-parent; empty
  // string clears it, same as --no-parent). Validated like every other link
  // (exists, not self, no cycle) and refused with the --set-parent wording.
  // Applied AFTER clearLinks/links/addLinks/removeLinks, so it wins when
  // combined — clearLinks:true + parent:X means "start over with exactly
  // this parent".
  parent: z
    .string()
    .optional()
    .describe(
      "Set/replace the parent task link (full id or unique prefix; same as the CLI's --set-parent). Empty string clears the parent (same as --no-parent). Applied after clearLinks/links/addLinks/removeLinks.",
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "Return only these task fields (e.g. [\"id\",\"status\"]) instead of the full task object — a status flip need not cost a full ticket dump. Omit for the full object.",
    ),
  // Verification verdict (parity with the CLI's --set-verify / --verify-reason):
  // "pass" => verified=true (green badge), "fail" => verified=false (amber
  // badge, the review gate rejects it), "cannot" => verified=absent (no badge)
  // and REQUIRES verifyReason, which is recorded in the task's activity.
  // Omitting the field leaves any stored verdict untouched. `vibeflow verify`
  // never writes this flag — only the agent does, and review-gate.ts Gate 4
  // requires a verdict that lets the task through on the review transition.
  setVerify: z
    .enum(["pass", "fail", "cannot"])
    .optional()
    .describe(
      "Your verification verdict: \"pass\" = the task IS implemented correctly (required for an annotated task at review), \"fail\" = it is NOT (the review gate blocks it), \"cannot\" = unverifiable here, which REQUIRES verifyReason. Omit to leave any stored verdict untouched.",
    ),
  verifyReason: z
    .string()
    .optional()
    .describe(
      "Why the task cannot be verified. REQUIRED with setVerify:\"cannot\", and refused as E_USAGE on its own — a reason belongs to a \"cannot\" verdict.",
    ),
  dryRun: z.boolean().default(false).describe(
    "Preview only: validate the edit and report what WOULD change without writing the task file.",
  ),
  // MERGE semantics, identical to the CLI's `--relates` / `--blocks` and to
  // `addLinks` below: every listed pair is ADDED, a pair already present is a
  // no-op (idempotent), and a link you leave out stays exactly where it is.
  // This is a deliberate change from the old REPLACE behaviour, which made a
  // partial array silently DELETE every link it omitted — the single most
  // destructive thing an MCP agent could do by accident.
  // `links: []` is refused (E_USAGE) rather than read as "clear": under merge an
  // empty array is almost certainly a client that still believes replace
  // semantics apply, and silently doing nothing would be the worst outcome. To
  // clear, say so explicitly with `clearLinks: true`.
  // Omit the field entirely and links are untouched.
  links: z
    .array(
      z.object({
        taskId: z.string().min(1),
        // SAFETY: TASK_LINK_TYPES is a readonly tuple; z.enum requires a mutable tuple type.
        type: z.enum(
          TASK_LINK_TYPES as unknown as [TaskLinkType, ...TaskLinkType[]],
        ),
      }),
    )
    .optional()
    .describe(
      "ADD the listed links without touching the rest (merge, same as the CLI's --relates/--blocks). A pair already present is a no-op. `links: []` is REFUSED — use clearLinks:true to clear. Combining `links` with `addLinks` merges their union once.",
    ),
  // CLEAR: drop the WHOLE link set in one call. Only `true` acts; `false` (or
  // an absent field) leaves links alone, so a client that always sends the flag
  // cannot wipe links by omission.
  // Combinable with the other three styles, and the order is fixed and
  // deterministic: clearLinks first, then the `links`/`addLinks` merge, then
  // `removeLinks` — so "start over and set exactly these, minus these" reads
  // the way it is written. `links: []` remains refused regardless.
  clearLinks: z
    .boolean()
    .optional()
    .describe(
      "Remove EVERY link from the task. Applied BEFORE the merge: clearLinks -> (links + addLinks) -> removeLinks. `true` clears; `false` or absent is a no-op.",
    ),
  // ADDITIVE: merge semantics, mirroring the CLI's `--relates` / `--blocks` and
  // the CLI's `--set-parent` (surgical, keeps every other link). A link already
  // present is a no-op, so the call is idempotent. Same meaning as `links`; when
  // both are sent they are merged as a union in ONE pass, never applied twice.
  addLinks: z
    .array(
      z.object({
        taskId: z.string().min(1),
        // SAFETY: as above — readonly tuple widened for z.enum.
        type: z.enum(
          TASK_LINK_TYPES as unknown as [TaskLinkType, ...TaskLinkType[]],
        ),
      }),
    )
    .optional()
    .describe(
      "ADD links without touching the rest (merge). Same semantics as `links` — sending both merges their union once. Use clearLinks:true to drop the whole set.",
    ),
  // SUBTRACTIVE: removes exactly the listed taskId+type pairs and leaves every
  // other link alone. A pair that is not present is a no-op. Applied LAST, after
  // clearLinks and after the links/addLinks merge.
  removeLinks: z
    .array(
      z.object({
        taskId: z.string().min(1),
        // SAFETY: as above — readonly tuple widened for z.enum.
        type: z.enum(
          TASK_LINK_TYPES as unknown as [TaskLinkType, ...TaskLinkType[]],
        ),
      }),
    )
    .optional()
    .describe(
      "REMOVE the listed links without touching the rest. Applied after clearLinks and after the links/addLinks merge.",
    ),
});
export type UpdateTaskInputType = z.infer<typeof UpdateTaskInput>;

export const ClaimNextTaskInput = z.object({
  type: z
    .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
    .optional()
    .describe("Only claim a task of this type. Omit to claim across all types."),
  user: z.string().optional().describe(
    "Only claim a task assigned to this user (matched against the task author). Omit to claim anyone's work.",
  ),
  tag: z.array(z.string()).optional().describe(
    "Only claim a task carrying every listed tag (AND). Omit for no tag filter.",
  ),
  dryRun: z.boolean().default(false).describe(
    "Preview only: name the task that WOULD be claimed without moving it to in-progress.",
  ),
});
export type ClaimNextTaskInputType = z.infer<typeof ClaimNextTaskInput>;

export const AddCommentInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one, of the task to comment on. An id that matches nothing is refused with TASK_NOT_FOUND; no task is created.",
    ),
  // Named `comment`, not `text`: the CLI flag is `--comment` and update_task
  // already uses `comment`, so one concept must not have two names.
  comment: z
    .string()
    .min(1)
    .describe(
      "The comment body — what changed, what you verified, what a reviewer should know. Required and non-empty: an empty body is refused by input validation before the tool runs.",
    ),
  author: z.enum(["agent", "user"]).default("agent").describe(
    "Comment author. Defaults to agent; the CLI always derives it from git config, so only MCP can override it.",
  ),
  dryRun: z.boolean().default(false).describe(
    "Preview only: validate the comment without writing it to the task.",
  ),
});
export type AddCommentInputType = z.infer<typeof AddCommentInput>;

export const AttachFileInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one, of the task to attach to. An id that matches nothing is refused with TASK_NOT_FOUND; no file is written.",
    ),
  filename: z
    .string()
    .min(1)
    .describe(
      "Bare filename, no directory part. The EXTENSION decides acceptance: a .md is what satisfies the research-report gate, and an unsupported extension is refused with UNSUPPORTED_FILE_TYPE.",
    ),
  contentB64: z
    .string()
    .min(1)
    .describe(
      "The file content, base64-encoded (not raw bytes, and not a path to read). Required: omitting it is refused by input validation before the tool runs.",
    ),
  dryRun: z.boolean().default(false).describe(
    "Preview only: validate the filename and payload without writing a file.",
  ),
});
export type AttachFileInputType = z.infer<typeof AttachFileInput>;

export const VerifyTaskInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one, resolved by the same shared rule every other task tool uses. An id that matches nothing is refused with E_NOT_FOUND (this tool runs the CLI verify engine, which has its own code), and every refusal it returns carries a `suggestion`.",
    ),
  url: z.string().url().optional().describe(
    "App URL to verify against. Overrides the task's stored url for this run only; omit to use the task's own url.",
  ),
  timeoutMs: z.number().min(1000).max(300000).default(60000).describe(
    "Per-run timeout in milliseconds (1000-300000, default 60000). Exceeding it refuses with VERIFY_TIMEOUT — raise it for slow apps.",
  ),
  // Preview only — never writes a task file and never launches a browser.
  // verify_task mutates (it adds a system comment and records a verdict), so
  // without this input the manifest's claim that every mutating tool exposes
  // a `dryRun` was false for this one tool.
  dryRun: z.boolean().default(false).describe(
    "Preview only: resolve the id and report that verification WOULD run, without launching a browser or writing anything.",
  ),
});
export type VerifyTaskInputType = z.infer<typeof VerifyTaskInput>;

export const PushTasksInput = z.object({
  workspace: z.string().optional(),
  keepLocalFiles: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});
export type PushTasksInputType = z.infer<typeof PushTasksInput>;

export const PullInput = z.object({
  board: z.string().optional().describe(
    "Board to pull from. Omit to use the saved board (same rule as the CLI's --board flag).",
  ),
  out: z.string().optional().describe(
    "Project root to write into instead of the server's own project (same as the CLI's --out flag). Omit to pull into the current project.",
  ),
  preferRemote: z.boolean().default(false).describe(
    "On a conflicting field the REMOTE value wins (same as the CLI's --prefer-remote flag). Default false: the local value wins and nothing is ever deleted.",
  ),
  dryRun: z.boolean().default(false).describe(
    "Preview only: report what WOULD be pulled without writing anything (same as the CLI's --dry-run flag).",
  ),
});
export type PullInputType = z.infer<typeof PullInput>;

export const StartKanbanInput = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe(
      "Port to bind. Defaults to 3700, the same default as the `vibeflow serve` / `vibeflow kanban` commands. Ignored when the server is already running.",
    ),
  host: z
    .string()
    .optional()
    .describe(
      "Bind hostname. Defaults to localhost; use 0.0.0.0 to expose the board on the LAN (the tool then also returns a localhost URL). Ignored when the server is already running.",
    ),
  // The manifest's own rule (`tests/unit/mcp/parity.test.ts`): a tool that is
  // not readOnly must expose a preview. Starting the board is exactly the kind
  // of side effect an agent wants to check before committing a port.
  dryRun: z
    .boolean()
    .default(false)
    .describe(
      "Preview only: report the URLs and guide the server WOULD serve, and bind nothing. Never starts a process.",
    ),
});
export type StartKanbanInputType = z.infer<typeof StartKanbanInput>;

export const GetIntegrationGuideInput = z.object({});
export type GetIntegrationGuideInputType = z.infer<
  typeof GetIntegrationGuideInput
>;

// ── Tool declarations (moved from CLI mcp/manifest.ts minus `run`, P4a) ──
export interface McpToolDeclaration {
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
}

export const MCP_TOOL_DECLARATIONS: McpToolDeclaration[] = [
  {
    name: "list_tasks",
    title: "List tasks",
    description:
      "List tasks with optional filters — the same listing as `vibeflow tasks` (same filters, same scope, same order). Unfiltered: ROOT tasks only (a child belongs to its parent's card — set children:true to include them). Filtered (status/type/user/tag): an explicit search returning EVERY match, children included. Counts are labelled by scope: totalMatching (every match), totalRoots (matching roots), hiddenChildren (matches omitted by root-only scope), returned (rows in `tasks`), limit (echoed RESOLVED — 0 is not supported and falls back to the default of 20, named in `limitNotice`; there is no unbounded mode, page with nextCursor or CLI --all for everything), truncated + hint (present only when the limit cut rows). Position: offset (0-based index of the first returned row), remaining (rows in THIS query's scope NOT in this response — totalRoots-based when root-only, totalMatching-based otherwise, so offset + returned + remaining always equals the scope size; 0 means exhausted), nextCursor (opaque continuation, null exactly when exhausted), order (the effective sort applied, so a continuation is stable). Projected rows (fields) always carry commentCount/fileCount even when the arrays are omitted. Use it to browse or search the board; use get_task when you already hold an id, and claim_next_task when you want the next unit of work claimed rather than just listed.",
    cliRef: {
      command: "tasks",
      flags: [
        "--status",
        "--type",
        "--user",
        "--tag",
        "--limit",
        "--all",
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
  },
  {
    name: "get_task",
    title: "Get task",
    description:
      "Get a single task by ID with full details including comments and files. Pass `fields` (e.g. [\"id\",\"title\",\"status\"]) for a compact projection instead of the full record. Read-only; changes nothing. Use it when list_tasks gave you an id or you already hold one; use list_tasks to search the board, and claim_next_task to pull the next unit of work.",
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
  },
  {
    name: "get_project",
    title: "Get project",
    description:
      "Return the resolved project this server is attached to: name, absolute root, git branch and mode. Read-only; takes no input and changes nothing. Call it when you need board location or branch context before operating on tasks.",
    cliRef: { command: "status", flags: [] },
    category: "admin",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: GetProjectInput.shape,
  },
  {
    name: "create_task",
    title: "Create task",
    description:
      "Create a new task with title, description, and metadata. Pass `fields` (e.g. [\"id\",\"title\",\"status\"]) for a compact answer instead of the full task object; pass dryRun to validate without writing anything. LINKS merge: `links` ADDS every listed taskId+type pair to the new task and `parent` (when given) is folded into the same union, so sending both merges once and a pair named twice is a no-op — the same MERGE semantic update_task has, where a link you do not name is simply absent (a new task has nothing to preserve). `links: []` is REFUSED — omit the field for no links. Use it for a new unit of work; use update_task to change an existing task, and add_comment to discuss one without editing it.",
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
  },
  {
    name: "update_task",
    title: "Update task",
    description:
      "Update an existing task. Supports status changes, title/description updates, adding comments, and changing the task's links (parent/relates/blocks). Pass `fields` (e.g. [\"id\",\"status\"]) for a compact answer instead of the full task object; pass dryRun to preview the edit without writing anything, and `branch` to record the work branch (required on the review transition when the project sets createBranch). REVIEW GATE (same rules as `vibeflow tasks --edit`, same codes): status \"review\" REQUIRES `comment` (refused REVIEW_COMMENT_REQUIRED); an ANNOTATED task (url + selector) additionally REQUIRES a verdict (`setVerify` pass/fail/cannot — refused VERIFY_REQUIRED); `commitMessage` is REQUIRED when auto-commit is ON (refused COMMIT_MESSAGE_REQUIRED); a Research task must NOT carry a verdict (refused RESEARCH_VERIFY_NOT_ALLOWED — submit Research with its .md report, no verdict). Pass setVerify to record your verification verdict: \"pass\" attests the task IS implemented correctly (verified=true, green badge — required for annotated tasks at the review transition, which `vibeflow verify` never sets itself), \"fail\" records that it is NOT implemented correctly (verified=false, amber badge, the review gate rejects it), and \"cannot\" clears the verdict back to absent (no badge) for a task that cannot be assessed here — \"cannot\" REQUIRES verifyReason, which is recorded in the task's activity. Use it to change a task you already hold; use add_comment to discuss without changing fields, and verify_task to actually RUN visual verification (a verdict here records an assessment, it runs nothing).\n\nLINKS — everything merges, and `clearLinks` is the only destructive path. `links` and `addLinks` both MERGE: a link you do not name is PRESERVED, and re-sending a link that is already there is a no-op, so neither of them can destroy a link by being incomplete. `removeLinks` removes exactly the taskId+type pairs you name and leaves every other link alone. `clearLinks: true` is the ONLY way to remove links wholesale — to drop a single link, name that taskId+type in `removeLinks` rather than editing `links`. Omitting all four fields leaves links untouched. The CLI's `--set-parent`/`--relates`/`--blocks`/`--unrelates`/`--unblocks` behave the same way (each is surgical and preserves every link it does not name), so the CLI and MCP surfaces now agree on link semantics.",
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
  },
  {
    name: "claim_next_task",
    title: "Claim next task",
    description:
      "Claim the highest-priority todo task and set it to in-progress: the returned object IS the claimed task. Roots first: a todo ROOT is claimed before any child — the root is the unit of work, so work through its children after claiming it. When no todo root is claimable, falls back to the highest-priority matching todo child and says so explicitly (a CHILD_CLAIM notice naming the parent), so todo work parented under a non-todo parent is never invisible. Optional type/user/tag filters narrow the pool (tags every-match); pass dryRun to preview the claim without moving the task. An empty board — or a valid filter matching nothing — is a SUCCESS with a `null` result, the same as 'vibeflow tasks --next --json' reporting `task:null` with exit 0. Use it to pull the next unit of work; use list_tasks to browse without claiming, and get_task to inspect a task you already hold.",
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
  },
  {
    name: "add_comment",
    title: "Add comment",
    description: "Add a comment to a task without changing any of its fields. The body is `comment` — the same name as the CLI's --comment flag and update_task's field. `author` defaults to agent; pass dryRun to validate without writing. Use it to discuss or record progress; use update_task's `comment` when the note accompanies a status or field change (review REQUIRES the note on the same call).",
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
  },
  {
    name: "attach_file",
    title: "Attach file",
    // The .md/Research role is stated HERE because this description is what a
    // client reads: it is the only place a refused agent learns that
    // attach_file is the recovery path for RESEARCH_REPORT_REQUIRED.
    description:
      "Attach a file to a task (content as base64) without changing any of its fields. Re-attaching an existing filename overwrites its bytes in place — the file list gains no duplicate. Pass dryRun to validate without writing. A filename ending in `.md` is what satisfies the research-report gate: a `type:\"Research\"` task is refused review with RESEARCH_REPORT_REQUIRED until a `.md` is attached, so attaching the report is how to recover from that refusal. Use it for reports, screenshots and evidence; use add_comment for discussion text.",
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
  },
  {
    name: "verify_task",
    title: "Verify task",
    description:
      "Run visual verification on a task with the Playwright engine: it loads the task's annotated page (url + selector) and compares the live element against the baseline captured at annotation time. MUTATES: every run appends a system comment with the outcome — pass dryRun to resolve the id and preview without launching a browser or writing anything. Pass `url` to check a different app URL for this run only, and `timeoutMs` (default 60000, refused VERIFY_TIMEOUT past it) for slow apps. A task with no baseline refuses with E_NO_BASELINE (re-annotate in `vibeflow kanban` to capture one); an unknown id with E_NOT_FOUND. Use it to check an annotated task before review; use update_task's setVerify to record the human verdict (this tool never sets it).",
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
  },
  {
    name: "pull",
    title: "Pull board",
    description:
      "Pull the online board into the local task store: the inverse of a push. ADDITIVE and never destructive — tasks and files the board holds are added or merged field-by-field into `.vibeflow/`, local-only data is never dropped, and nothing is ever deleted. On a conflicting field the LOCAL value wins by default; pass preferRemote to let the remote value win instead. A second pull of an unchanged board is a byte-no-op (unchanged tasks are not rewritten, identical files untouched). Pass dryRun to preview the pull (added/merged/unchanged counts) without writing anything. Use it to bring a board's tasks and file bytes local after working in another checkout or on the web; use list_tasks to browse without writing, and push to send local work up.",
    cliRef: {
      command: "pull",
      flags: ["--board", "--out", "--prefer-remote", "--dry-run"],
    },
    category: "task-write",
    annotations: {
      // Writes the local task store (new task files, merged records, file
      // bytes), so it is not a read — but it never deletes anything and a
      // re-pull converges to a no-op, so a repeat call is safe.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      // Fetches the board archive from the SaaS backend over the network.
      openWorldHint: true,
    },
    input: PullInput.shape,
  },
  {
    name: "start_kanban",
    title: "Start kanban server",
    description:
      "Start the local kanban board server and return the instruction block the CLI prints: the kanban URL, the localhost URL when bound to 0.0.0.0, the agent prompt, and the overlay integration guide. IDEMPOTENT — one server per process; a second call returns the running instance (alreadyRunning:true) instead of fighting for the port. Pass dryRun to report the URLs without binding anything. Call it once before get_integration_guide so the guide carries real URLs; skip it entirely for remote or Docker setups where a localhost server is unreachable.",
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
  },
];

/**
 * Tools that exist ONLY on the LOCAL surface.
 *
 * A hosted MCP server has no project directory. `pull` writes records into the
 * caller's local store, so a cloud runner has nothing to write to — it is not a
 * missing feature, it is a surface with no filesystem.
 *
 * The exclusion is DECLARED rather than implied by the hosted implementation,
 * because the two surfaces must not drift silently: without this export the
 * hosted server's name list and this declaration are two independent facts that
 * can disagree (measured: `pull` was added here and the hosted surface kept
 * answering 11 tools, which only a DB-gated test noticed). With it, a parity
 * test can assert a TOTAL PARTITION — every declared tool is either hosted or
 * CLI-only, never both, never neither — and adding a tool forces a decision.
 */
export const CLI_ONLY_MCP_TOOLS = ["pull"] as const;
export type CliOnlyMcpTool = (typeof CLI_ONLY_MCP_TOOLS)[number];

/** The declarations a HOSTED server must register: everything else. */
export const HOSTED_MCP_TOOL_DECLARATIONS = MCP_TOOL_DECLARATIONS.filter(
  (tool) => !(CLI_ONLY_MCP_TOOLS as readonly string[]).includes(tool.name),
);
