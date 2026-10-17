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
  status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).optional(),
  type: z
    .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
    .optional(),
  user: z.string().optional(),
  tag: z.array(z.string()).optional(),
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
  children: z.boolean().default(false),
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
  fields: z.array(z.string()).optional(),
});
export type GetTaskInputType = z.infer<typeof GetTaskInput>;

// No input by design: the project root is resolved once at server startup
// (ctx.projectDir) and is never a per-call parameter — see getProject below.
export const GetProjectInput = z.object({});
export type GetProjectInputType = z.infer<typeof GetProjectInput>;

export const CreateTaskInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  // SAFETY: TASK_STATUSES is a readonly tuple; z.enum requires a mutable tuple type.
  status: z
    .enum(TASK_STATUSES as unknown as [string, ...string[]])
    .default("todo"),
  type: z
    .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
    .default("Task"),
  priority: z.enum(["Critical", "High", "Medium", "Low"]).default("Medium"),
  tags: z.array(z.string()).optional(),
  url: z.string().optional(),
  selector: z.string().default("/"),
  cssSelector: z.string().optional(),
  // Optional explicit ordering key; core auto-assigns one when omitted.
  sortKey: z.string().optional(),
  // Optional parent task id (full id or unique prefix); links the new task
  // under it as a child.
  parent: z.string().min(1).optional(),
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
  dryRun: z.boolean().default(false),
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
  status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  branch: z.string().optional(),
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
  dryRun: z.boolean().default(false),
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
    .optional(),
  user: z.string().optional(),
  tag: z.array(z.string()).optional(),
  dryRun: z.boolean().default(false),
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
  author: z.enum(["agent", "user"]).default("agent"),
  dryRun: z.boolean().default(false),
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
  dryRun: z.boolean().default(false),
});
export type AttachFileInputType = z.infer<typeof AttachFileInput>;

export const ExportPromptInput = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "A FULL task id to export — this tool matches ids EXACTLY, so a prefix is NOT resolved and is refused with TASK_NOT_FOUND. Omit it (or pass `ids`) to export the whole board.",
    ),
  // Real behaviour, stated because it differs from the other id-bearing tools:
  // no prefix resolution, and an id that matches nothing is SKIPPED rather than
  // refused (a list is best-effort), so the answer can name fewer tasks than
  // were asked for.
  ids: z
    .array(z.string())
    .optional()
    .describe(
      "FULL task ids to export, matched exactly. An id that matches no task is skipped rather than refused, so check that the rendered output names every id you asked for.",
    ),
  format: z.enum(["markdown", "json"]).default("markdown"),
});
export type ExportPromptInputType = z.infer<typeof ExportPromptInput>;

export const VerifyTaskInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one, resolved by the same shared rule every other task tool uses. An id that matches nothing is refused with E_NOT_FOUND (this tool runs the CLI verify engine, which has its own code), and every refusal it returns carries a `suggestion`.",
    ),
  url: z.string().url().optional(),
  timeoutMs: z.number().min(1000).max(300000).default(60000),
  // Preview only — never writes a task file and never launches a browser.
  // verify_task mutates (it adds a system comment and records a verdict), so
  // without this input the manifest's claim that every mutating tool exposes
  // a `dryRun` was false for this one tool.
  dryRun: z.boolean().default(false),
});
export type VerifyTaskInputType = z.infer<typeof VerifyTaskInput>;

export const PushTasksInput = z.object({
  workspace: z.string().optional(),
  keepLocalFiles: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});
export type PushTasksInputType = z.infer<typeof PushTasksInput>;

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
      "List tasks with optional filters — the same listing as `vibeflow tasks` (same filters, same scope, same order). Unfiltered: ROOT tasks only (a child belongs to its parent's card — set children:true to include them). Filtered (status/type/user/tag): an explicit search returning EVERY match, children included. Counts are labelled by scope: totalMatching (every match), totalRoots (matching roots), hiddenChildren (matches omitted by root-only scope), returned (rows in `tasks`), limit (echoed RESOLVED — 0 is not supported and falls back to the default of 20, named in `limitNotice`; there is no unbounded mode, page with nextCursor or CLI --all for everything), truncated + hint (present only when the limit cut rows). Position: offset (0-based index of the first returned row), remaining (rows in THIS query's scope NOT in this response — totalRoots-based when root-only, totalMatching-based otherwise, so offset + returned + remaining always equals the scope size; 0 means exhausted), nextCursor (opaque continuation, null exactly when exhausted), order (the effective sort applied, so a continuation is stable). Projected rows (fields) always carry commentCount/fileCount even when the arrays are omitted.",
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
  },
  {
    name: "create_task",
    title: "Create task",
    description:
      "Create a new task with title, description, and metadata. Pass `fields` (e.g. [\"id\",\"title\",\"status\"]) for a compact answer instead of the full task object. LINKS merge: `links` ADDS every listed taskId+type pair to the new task and `parent` (when given) is folded into the same union, so sending both merges once and a pair named twice is a no-op — the same MERGE semantic update_task has, where a link you do not name is simply absent (a new task has nothing to preserve). `links: []` is REFUSED — omit the field for no links.",
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
      "Update an existing task. Supports status changes, title/description updates, adding comments, and changing the task's links (parent/relates/blocks). REVIEW GATE (same rules as `vibeflow tasks --edit`, same codes): status \"review\" REQUIRES `comment` (refused REVIEW_COMMENT_REQUIRED); an ANNOTATED task (url + selector) additionally REQUIRES a verdict (`setVerify` pass/fail/cannot — refused VERIFY_REQUIRED); `commitMessage` is REQUIRED when auto-commit is ON (refused COMMIT_MESSAGE_REQUIRED); a Research task must NOT carry a verdict (refused RESEARCH_VERIFY_NOT_ALLOWED — submit Research with its .md report, no verdict). Pass setVerify to record your verification verdict: \"pass\" attests the task IS implemented correctly (verified=true, green badge — required for annotated tasks at the review transition, which `vibeflow verify` never sets itself), \"fail\" records that it is NOT implemented correctly (verified=false, amber badge, the review gate rejects it), and \"cannot\" clears the verdict back to absent (no badge) for a task that cannot be assessed here — \"cannot\" REQUIRES verifyReason, which is recorded in the task's activity.\n\nLINKS — everything merges, and `clearLinks` is the only destructive path. `links` and `addLinks` both MERGE: a link you do not name is PRESERVED, and re-sending a link that is already there is a no-op, so neither of them can destroy a link by being incomplete. `removeLinks` removes exactly the taskId+type pairs you name and leaves every other link alone. `clearLinks: true` is the ONLY way to remove links wholesale — to drop a single link, name that taskId+type in `removeLinks` rather than editing `links`. Omitting all four fields leaves links untouched. The CLI's `--set-parent`/`--relates`/`--blocks`/`--unrelates`/`--unblocks` behave the same way (each is surgical and preserves every link it does not name), so the CLI and MCP surfaces now agree on link semantics.",
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
      "Claim the highest-priority todo task and set it to in-progress. Roots first: a todo ROOT is claimed before any child — the root is the unit of work, so work through its children after claiming it. When no todo root is claimable, falls back to the highest-priority matching todo child and says so explicitly (a CHILD_CLAIM notice naming the parent), so todo work parented under a non-todo parent is never invisible. Mirrors 'vibeflow tasks --next'. An empty board is a SUCCESS, not a failure: the result is then `null` (an object means a task was claimed, `null` means there was nothing to claim), the same as 'vibeflow tasks --next --json' reporting `task:null` with exit 0. A valid filter that matches no task is the same situation and gives the same `null`.",
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
