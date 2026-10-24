/**
 * Operation registry — the machine-checked map of CLI ↔ operation ↔ MCP
 * (P0 ratchet, ticket 2d789b27).
 *
 * WHAT: one row per operation with its backend mode, its CLI bindings, its
 * MCP tools, and whether the mapping is 1:1, intentionally different, or
 * missing. This file is the DECLARED contract; the generator
 * (`scripts/generate-operation-registry.mjs`) derives the live facts from
 * the code and emits `operation-registry.gen.json`; the ratchet
 * (`tests/unit/operation-boundary.test.ts`) fails when the three disagree.
 *
 * WHY a hand-written table plus a generator (not one or the other): the
 * table records intent (mode, mapping kind) that cannot be inferred from
 * syntax; the generator records facts (command/flag/tool/field names) that
 * must not be hand-copied. A new flag with no row here fails check 1; a
 * row naming something deleted fails check 2; a schema edit without a
 * regen fails check 3; a mode edit without a regen fails check 4.
 *
 * Rows are alphabetical by operation id so diffs stay reviewable.
 * Decision: owner mandate via parent e7482da5; agent implementation P0.
 */
import type {
  BackendRequirement,
  MappingKind,
  OperationId,
  OperationMode,
} from "@vibeflow-tools/api-core";

export interface OperationRecord {
  id: OperationId;
  mode: OperationMode;
  requirement: BackendRequirement;
  mapping: MappingKind;
  /** CLI bindings: command paths ("auth login") or "command --flag" keys. */
  cli: readonly string[];
  /** Manifest tool names (empty when the operation has no MCP tool). */
  mcpTools: readonly string[];
  /**
   * Exported symbol in `core/operations.ts`, or null when the operation is
   * not yet extracted (P1–P7 create it). Null is honest, not a hole: the
   * ratchet asserts non-null symbols are still exported functions.
   */
  operationFn: string | null;
  reason: string;
}

export const OPERATION_REGISTRY: Record<OperationId, OperationRecord> = {
  addComment: {
    id: "addComment",
    mode: "both",
    requirement: "selected-board",
    mapping: "one-to-one",
    cli: ["tasks --edit", "tasks --comment"],
    mcpTools: ["add_comment"],
    operationFn: "addComment",
    reason:
      "Same function both surfaces; the CLI form is always tasks --edit <id> --comment (bare --comment is refused E_USAGE).",
  },
  attachFile: {
    id: "attachFile",
    mode: "both",
    requirement: "selected-board",
    mapping: "intentionally-different",
    cli: ["tasks --edit", "tasks --set-status", "tasks --report-file"],
    mcpTools: ["attach_file"],
    operationFn: "attachFile",
    reason:
      "Duplicate policy differs by surface (CLI refuses, MCP replaces in place) — see KNOWN_DELTAS attach-duplicate-policy. Unified behind the explicit onExisting input of the shared attachFile implementation (P5 landed).",
  },
  claimNextTask: {
    id: "claimNextTask",
    mode: "both",
    requirement: "selected-board",
    mapping: "one-to-one",
    cli: ["tasks --next", "tasks --type", "tasks --tag"],
    mcpTools: ["claim_next_task"],
    operationFn: "claimNextTask",
    reason:
      "Roots-first/type/tag/dry-run semantics shared; empty claim is ok:true with a null payload on both.",
  },
  clearVerificationAuthState: {
    id: "clearVerificationAuthState",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["auth --clear"],
    mcpTools: [],
    operationFn: null,
    reason:
      "FINAL: credential-state clearing is a local file mutation behind an explicit human flag; it is never an MCP tool because a remote client must not be able to wipe the operator's local encrypted auth state. No operation wrapper is planned — the function in commands/auth.ts IS the implementation, classified here rather than routed.",
  },
  commitTaskPathsOperation: {
    id: "commitTaskPathsOperation",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["tasks --commit", "tasks --task", "tasks --message"],
    mcpTools: [],
    operationFn: "commitTaskPathsOperation",
    reason:
      "Explicit pathspec git commit stays CLI-only; no MCP destructive tool is added (P5).",
  },
  createTask: {
    id: "createTask",
    mode: "both",
    requirement: "selected-board",
    mapping: "one-to-one",
    cli: [
      "tasks --add",
      "tasks --title",
      "tasks --description",
      "tasks --type",
      "tasks --priority",
      "tasks --tag",
      "tasks --parent",
      "tasks --url",
      "tasks --selector",
      "tasks --sort-key",
      "tasks --fields",
    ],
    mcpTools: ["create_task"],
    operationFn: "createTask",
    reason:
      "Links merge on both (parent folded into the same union); links:[] refused on both.",
  },
  deleteTaskOperation: {
    id: "deleteTaskOperation",
    mode: "both",
    requirement: "selected-board",
    mapping: "missing",
    cli: ["tasks --delete", "tasks --yes"],
    mcpTools: [],
    operationFn: "deleteTaskOperation",
    reason:
      "Local parent refusal vs online cascade differ by backend; no MCP delete tool is added (P5 landed the shared deleteTaskOperation — CLI-only by design).",
  },
  getAccountStatus: {
    id: "getAccountStatus",
    mode: "both",
    requirement: "none",
    mapping: "intentionally-different",
    cli: [
      "status",
      "status --json",
      "auth",
      "auth --clear",
      "auth --list",
      "auth --json",
      "auth status",
      "auth status --json",
    ],
    mcpTools: [],
    operationFn: null,
    reason:
      "FINAL: human login/count summary with a legacy text envelope; deliberately no MCP tool — get_project is the machine probe. The status renderer reads through the same ports the operations use; no separate operation wrapper is planned because the output is human text with legacy exit codes, classified here rather than routed.",
  },
  getChangelog: {
    id: "getChangelog",
    mode: "local",
    requirement: "none",
    mapping: "missing",
    cli: ["changelog", "changelog --all"],
    mcpTools: [],
    operationFn: "getChangelog",
    reason:
      "Raw packed-text selection through the shared operation; CLI-only, no envelope (P6 landed).",
  },
  getIntegrationGuide: {
    id: "getIntegrationGuide",
    mode: "local",
    requirement: "local-only",
    mapping: "one-to-one",
    cli: ["kanban"],
    mcpTools: ["get_integration_guide"],
    operationFn: "getIntegrationGuide",
    reason:
      "Same function; hosted answers a board snippet instead (KNOWN_DELTAS hosted-guide-answers).",
  },
  getOpenApiDocument: {
    id: "getOpenApiDocument",
    mode: "local",
    requirement: "none",
    mapping: "missing",
    cli: ["openapi", "openapi --yaml"],
    mcpTools: [],
    operationFn: "getOpenApiDocument",
    reason:
      "Raw bundled spec selection through the shared operation; CLI-only, no envelope (P6 landed).",
  },
  getProject: {
    id: "getProject",
    mode: "both",
    requirement: "none",
    mapping: "intentionally-different",
    cli: ["status"],
    mcpTools: ["get_project"],
    operationFn: "getProject",
    reason:
      "Partial counterpart only: the tool reports project identity while status/auth status add account/counts and human text.",
  },
  getTask: {
    id: "getTask",
    mode: "both",
    requirement: "selected-board",
    mapping: "one-to-one",
    cli: ["tasks --get", "tasks --fields"],
    mcpTools: ["get_task"],
    operationFn: "getTask",
    reason:
      "Full-id-or-prefix resolution and projection(+counts) shared; relations derived identically.",
  },
  inspectVerificationEvidence: {
    id: "inspectVerificationEvidence",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["verify"],
    mcpTools: [],
    operationFn: "inspectVerificationEvidence",
    reason:
      "The five evidence-query forms (style_query/style_diff/element_info/html_diff/html_query) run through the shared operation; CLI-only, no MCP tool (P7 landed).",
  },
  linkCommitAuthors: {
    id: "linkCommitAuthors",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["authors", "authors link"],
    mcpTools: [],
    operationFn: "linkCommitAuthors",
    reason:
      "Git-tracked store enrichment through the shared operation; stays a deliberate human action, never a remotely triggered write (P6 landed).",
  },
  listTasks: {
    id: "listTasks",
    mode: "both",
    requirement: "selected-board",
    mapping: "one-to-one",
    cli: [
      "tasks",
      "tasks --status",
      "tasks --type",
      "tasks --user",
      "tasks --tag",
      "tasks --limit",
      "tasks --all",
      "tasks --fields",
      "tasks --children",
    ],
    mcpTools: ["list_tasks"],
    operationFn: "listTasks",
    reason:
      "Filter/scope/sort/counts come from the one shared listing model; --all is the CLI-only unbounded assembly (KNOWN_DELTAS cli-only-unbounded-listing).",
  },
  listVerificationAuthState: {
    id: "listVerificationAuthState",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["auth --list"],
    mcpTools: [],
    operationFn: null,
    reason: "FINAL: encrypted per-task auth-state listing for a human operator; local-only by design and never an MCP tool. Listed here rather than routed: the reader in commands/auth.ts IS the implementation.",
  },
  loginAccount: {
    id: "loginAccount",
    mode: "online",
    requirement: "none",
    mapping: "missing",
    cli: ["login", "auth login"],
    mcpTools: [],
    operationFn: null,
    reason:
      "FINAL: interactive device flow (browser approval, TTY prompts, polling) that cannot be driven over MCP by construction; one implementation serves both alias spellings. Never an MCP tool — a remote client must not be able to start an interactive login. Classified here rather than routed.",
  },
  logoutAccount: {
    id: "logoutAccount",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["logout", "auth logout"],
    mcpTools: [],
    operationFn: null,
    reason: "FINAL: local credential mutation (token + workspace removal); never an MCP tool — a remote client must not be able to log the operator out. Classified here rather than routed.",
  },
  manageTelemetry: {
    id: "manageTelemetry",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["telemetry", "telemetry --enable", "telemetry --disable", "telemetry --status"],
    mcpTools: [],
    operationFn: "manageTelemetry",
    reason:
      "Global telemetry opt-in/out config through the shared operation; CLI-only (P6 landed).",
  },
  normalizeTaskStore: {
    id: "normalizeTaskStore",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["tasks --normalize", "tasks --apply"],
    mcpTools: [],
    operationFn: "normalizeTaskStore",
    reason: "One-time local store healing (dry-run default); CLI-only maintenance (P5).",
  },
  pullFromBoard: {
    id: "pullFromBoard",
    mode: "both",
    requirement: "sync",
    mapping: "one-to-one",
    cli: ["pull", "pull --board", "pull --out", "pull --prefer-remote", "pull --prefer-local"],
    mcpTools: ["pull"],
    operationFn: "pullFromBoard",
    reason:
      "Same additive-merge function; hosted has no local store so no tool there (KNOWN_DELTAS hosted-pull-absent).",
  },
  pushTasks: {
    id: "pushTasks",
    mode: "both",
    requirement: "sync",
    mapping: "missing",
    cli: [
      "push",
      "push --board",
      "push --workspace",
      "push --keep-local-files",
      "push --prune-local",
      "push --dry-run",
      "push --verbose",
      "push --json",
    ],
    mcpTools: [],
    operationFn: "pushTasks",
    reason:
      "Hidden CLI sync with no MCP tool — do not resurrect push_tasks; the drift gate pins its absence (P6 repairs the service).",
  },
  readPageDom: {
    id: "readPageDom",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: [],
    mcpTools: [],
    operationFn: "readPageDom",
    reason:
      "Chat-only live-DOM read scoped to its session tab; read-only and approval-free, never a board write, with no CLI spelling and no main-manifest MCP tool (P7 landed).",
  },
  readPageText: {
    id: "readPageText",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: [],
    mcpTools: [],
    operationFn: "readPageText",
    reason:
      "Chat-only server-side page-text fetch behind the bounded SSRF-guarded reader; read-only and approval-free, never a board write, with no CLI spelling and no main-manifest MCP tool (P7 landed).",
  },
  reindexTaskSortKeys: {
    id: "reindexTaskSortKeys",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["tasks --reindex-sort-keys"],
    mcpTools: [],
    operationFn: "reindexTaskSortKeys",
    reason: "One-time local board-ordering maintenance; CLI-only (P5).",
  },
  startKanban: {
    id: "startKanban",
    mode: "local",
    requirement: "local-only",
    mapping: "one-to-one",
    cli: ["kanban", "kanban --port", "kanban --host", "kanban --dev", "kanban --no-open"],
    mcpTools: ["start_kanban"],
    operationFn: "startKanban",
    reason:
      "Same singleton lifecycle through the shared operation; --dev rides the operation into the singleton (which never opens a browser, so --no-open stays renderer-side), and changelog chrome stays CLI-side.",
  },
  startMcpTransport: {
    id: "startMcpTransport",
    mode: "local",
    requirement: "none",
    mapping: "missing",
    cli: ["mcp", "mcp --project"],
    mcpTools: [],
    operationFn: "startMcpTransport",
    reason:
      "Stdio transport bootstrap, not a board tool; the CLI handler resolves the root, announces on stderr, and starts the transport through this operation (P7 landed).",
  },
  startServer: {
    id: "startServer",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["serve"],
    mcpTools: [],
    operationFn: "startServer",
    reason:
      "Prototype/API-only server lifecycle through the shared operation; prototype viewer unpaired by design, kanban CLI routing remains (P7 landed).",
  },
  updateTask: {
    id: "updateTask",
    mode: "both",
    requirement: "selected-board",
    mapping: "one-to-one",
    cli: [
      "tasks --edit",
      "tasks --set-status",
      "tasks --title",
      "tasks --description",
      "tasks --branch",
      "tasks --comment",
      "tasks --commit-message",
      "tasks --set-verify",
      "tasks --verify-reason",
      "tasks --set-parent",
      "tasks --no-parent",
      "tasks --relates",
      "tasks --blocks",
      "tasks --unrelates",
      "tasks --unblocks",
      "tasks --fields",
    ],
    mcpTools: ["update_task"],
    operationFn: "updateTask",
    reason:
      "Review gate, attestation, link merge and partial-success notices shared; wire envelopes differ by renderer only.",
  },
  verifyTaskOp: {
    id: "verifyTaskOp",
    mode: "local",
    requirement: "local-only",
    mapping: "intentionally-different",
    cli: ["verify", "verify --url", "verify --timeout"],
    mcpTools: ["verify_task"],
    operationFn: "verifyTaskOp",
    reason:
      "Same engine call; CLI prints the raw VerifyResult while MCP wraps operation data, and evidence-query forms are CLI-only. Hosted refuses local-only (KNOWN_DELTAS hosted-verify-local-only).",
  },
};

/**
 * The mode→operation intent map: every "command --flag" the registry owns,
 * each pointing at the operation that handles it — either routed through
 * the shared implementation or classified in SURFACE_STORAGE_USES with the
 * owning operation named (TEMPORARY_CLI_FLAGS is empty since P8: nothing
 * is "not-yet-routed"). Shared flags (--title,
 * --type, --comment …) point at their primary operation; coverage — not
 * uniqueness — is what the ratchet asserts. Formatting/preview flags
 * (--json, --dry-run) and mode selectors owned by the tool name itself are
 * NOT here: they are classified in `intentionallyNotExposed.flags`, which
 * the ratchet reads as the second coverage source.
 */
export const REGISTRY_CLI_FLAGS: Record<string, OperationId> = {
  "authors link --dry-run": "linkCommitAuthors",
  "changelog --all": "getChangelog",
  "kanban --dev": "startKanban",
  "kanban --host": "startKanban",
  "kanban --no-open": "startKanban",
  "kanban --port": "startKanban",
  "openapi --yaml": "getOpenApiDocument",
  "telemetry --disable": "manageTelemetry",
  "telemetry --enable": "manageTelemetry",
  "telemetry --status": "manageTelemetry",
  "mcp --project": "startMcpTransport",
  "serve --dev": "startServer",
  "serve --host": "startServer",
  "serve --no-open": "startServer",
  "serve --port": "startServer",
  "serve --project": "startServer",
  "auth --clear": "clearVerificationAuthState",
  "auth --json": "getAccountStatus",
  "auth --list": "listVerificationAuthState",
  "auth status --json": "getAccountStatus",
  "status --json": "getAccountStatus",
  "pull --board": "pullFromBoard",
  "pull --dry-run": "pullFromBoard",
  "pull --json": "pullFromBoard",
  "pull --out": "pullFromBoard",
  "pull --prefer-local": "pullFromBoard",
  "pull --prefer-remote": "pullFromBoard",
  "tasks --add": "createTask",
  "tasks --all": "listTasks",
  "tasks --apply": "normalizeTaskStore",
  "tasks --attach": "attachFile",
  "tasks --branch": "updateTask",
  "tasks --children": "listTasks",
  "tasks --comment": "updateTask",
  "tasks --commit": "commitTaskPathsOperation",
  "tasks --commit-message": "updateTask",
  "tasks --delete": "deleteTaskOperation",
  "tasks --description": "updateTask",
  "tasks --fields": "listTasks",
  "tasks --get": "getTask",
  "tasks --limit": "listTasks",
  "tasks --message": "commitTaskPathsOperation",
  "tasks --move": "attachFile",
  "tasks --next": "claimNextTask",
  "tasks --normalize": "normalizeTaskStore",
  "tasks --no-parent": "updateTask",
  "tasks --parent": "createTask",
  "tasks --priority": "createTask",
  "tasks --reindex-sort-keys": "reindexTaskSortKeys",
  "tasks --relates": "updateTask",
  "tasks --report-file": "attachFile",
  "tasks --selector": "createTask",
  "tasks --set-parent": "updateTask",
  "tasks --set-status": "updateTask",
  "tasks --set-verify": "updateTask",
  "tasks --sort-key": "createTask",
  "tasks --status": "listTasks",
  "tasks --tag": "listTasks",
  // --task is shared by the --commit and --attach modes; it points at its
  // first-listed owner here — coverage, not uniqueness, is asserted.
  "tasks --task": "commitTaskPathsOperation",
  "tasks --title": "createTask",
  "tasks --type": "listTasks",
  "tasks --unblocks": "updateTask",
  "tasks --unrelates": "updateTask",
  "tasks --url": "createTask",
  "tasks --user": "listTasks",
  "tasks --verify-reason": "updateTask",
  "tasks --yes": "deleteTaskOperation",
  "push --board": "pushTasks",
  "push --keep-local-files": "pushTasks",
  "push --dry-run": "pushTasks",
  "push --json": "pushTasks",
  "push --prune-local": "pushTasks",
  "push --verbose": "pushTasks",
  "push --workspace": "pushTasks",
  "verify --filter": "inspectVerificationEvidence",
  "verify --json": "verifyTaskOp",
  "verify --timeout": "verifyTaskOp",
  "verify --url": "verifyTaskOp",
};

/**
 * Live CLI flags that are real product modes still inline in `src/index.ts`
 * — each names its removal phase: the ratchet treats them as covered TODAY
 * but fails entries that outlive their phase's bypass removal. No silent
 * catch-all: every entry carries the phase and the reason.
 *
 * Empty since P5 and locked empty by P8 (ticket dc9a42ac): every routed
 * mode stays routed, and no new inline mode may land without a registry
 * row. The remaining inline call sites in surface modules are NOT tracked
 * here — they are classified per call site in SURFACE_STORAGE_USES below,
 * which the ratchet enforces (a new unlisted storage use fails; a listed
 * use that disappears fails as stale).
 */
export const TEMPORARY_CLI_FLAGS: Record<
  string,
  { phase: string; reason: string }
> = {};

/** All operation ids, alphabetical — the registry's key order. */
export const OPERATION_IDS = Object.keys(OPERATION_REGISTRY).sort();

/**
 * Final surface storage-use inventory (P8, ticket dc9a42ac).
 *
 * WHAT: every runtime import of a task-storage module
 * (`core/tasks.js`, `core/comments.js`, `core/files.js`) by a surface
 * module (`src/index.ts`, `src/mcp/*.ts`, `src/server/agent-chat/*.ts`,
 * `src/cli/renderers/*.ts`) — keyed `"<file> <callee>"` — with the owning
 * operation and the reason the call site lives surface-side.
 *
 * WHY an inventory instead of a ban: renderers MUST read through display
 * helpers (plan §1.6 — rendering belongs in surfaces), and the local
 * add/edit write paths predate operation extraction. Both are classified
 * here with their owning operation so nothing is "temporarily" duplicated:
 * a NEW unlisted storage use fails the ratchet, a listed use that
 * disappears fails as stale, and routing a write path through its operation
 * removes that row. The inventory can only shrink.
 *
 * `operation: "renderer"` is permanent surface-side display/bootstrap with
 * no owning board operation. Every `write-path` row names the operation it
 * owns to — that is the routing target, not a second implementation.
 */
export interface SurfaceStorageUse {
  operation: OperationId | "renderer";
  kind: "renderer" | "bootstrap" | "write-path";
  reason: string;
}

export const SURFACE_STORAGE_USES: Record<string, SurfaceStorageUse> = {
  "src/index.ts createTask": {
    operation: "createTask",
    kind: "write-path",
    reason:
      "Local tasks --add builds and writes the record inline (validation, parents, clone persistence). Owns to createTask; routing the add flow through the shared operation removes this row.",
  },
  "src/index.ts updateTask": {
    operation: "updateTask",
    kind: "write-path",
    reason:
      "Local tasks --edit writes the record inline (review gate, links, attestation, auto-commit follow-ons). Owns to updateTask; routing the edit flow through the shared operation removes this row.",
  },
  "src/index.ts addComment": {
    operation: "addComment",
    kind: "write-path",
    reason:
      "Local tasks --edit writes --comment and the cannot-reason system comment inline after the task write. Owns to addComment (the comment input of updateTask when routed).",
  },
  "src/index.ts saveFile": {
    operation: "attachFile",
    kind: "write-path",
    reason:
      "Research --report-file bytes are saved and the source consumed inline (dynamic import of core/files.js). Owns to attachFile; routing report submission through the shared operation removes this row.",
  },
  "src/index.ts markTaskOpened": {
    operation: "getTask",
    kind: "write-path",
    reason:
      "tasks --get marks the task opened inline after the shared getTask operation resolves it. Owns to getTask; folding the mark into the operation removes this row.",
  },
  "src/index.ts ensureTaskDirs": {
    operation: "renderer",
    kind: "bootstrap",
    reason:
      "Filesystem scaffolding for local flows and dry-run previews; creates directories, never decides task state.",
  },
  "src/index.ts generateTaskId": {
    operation: "renderer",
    kind: "bootstrap",
    reason:
      "Pure id minting for dry-run previews and local creates; no store access.",
  },
  "src/index.ts listTasks": {
    operation: "listTasks",
    kind: "renderer",
    reason:
      "Local inline reads (validation snapshots, display enumeration) through the shared listing model the listTasks operation queries. Read-only display/validation use; writes own to their operations.",
  },
  "src/index.ts listTasksWithPaths": {
    operation: "getAccountStatus",
    kind: "renderer",
    reason:
      "Status/count display enumeration for the human status renderer (getAccountStatus has no MCP tool by design); read-only display use.",
  },
  "src/index.ts formatTaskForAgent": {
    operation: "renderer",
    kind: "renderer",
    reason:
      "Pure display formatting for agent instructions; no store decisions.",
  },
  "src/index.ts renderTaskForAgent": {
    operation: "renderer",
    kind: "renderer",
    reason:
      "Pure display formatting for tasks --get human output; no store decisions.",
  },
  "src/index.ts renderAgentInstructions": {
    operation: "renderer",
    kind: "renderer",
    reason:
      "Pure display text for agent guidance; no store access.",
  },
  "src/index.ts summariseChildren": {
    operation: "renderer",
    kind: "renderer",
    reason:
      "Pure display folding of child rows for claim output; no store decisions.",
  },
  "src/index.ts findTaskFilePath": {
    operation: "renderer",
    kind: "renderer",
    reason:
      "Display path lookup so human output can name the record file; never writes.",
  },
  "src/index.ts getParentId": {
    operation: "renderer",
    kind: "renderer",
    reason:
      "Pure relation read for display derivation; no store decisions.",
  },
  "src/index.ts isResearchType": {
    operation: "renderer",
    kind: "renderer",
    reason:
      "Pure type predicate for display branching; no store access.",
  },
  "src/index.ts getCurrentUserId": {
    operation: "renderer",
    kind: "bootstrap",
    reason:
      "Local identity for display payloads and the opened-by mark; not a task-state decision.",
  },
};
