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
      "Duplicate policy differs by surface (CLI refuses, MCP replaces in place) — see KNOWN_DELTAS attach-duplicate-policy. P5 unifies behind an explicit input.",
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
      "Credential-state clearing is a local file mutation, never an MCP tool (P6 extracts the operation).",
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
      "Local parent refusal vs online cascade differ today; no MCP delete tool is added (P5).",
  },
  getAccountStatus: {
    id: "getAccountStatus",
    mode: "both",
    requirement: "none",
    mapping: "intentionally-different",
    cli: ["status", "auth", "auth status"],
    mcpTools: [],
    operationFn: null,
    reason:
      "Human login/count summary with a legacy text envelope; deliberately no MCP tool — get_project is the machine probe (P6 unifies the implementation).",
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
      "Raw packed-text selection through the shared operation; CLI-only, no envelope (P6 increment 1).",
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
      "Raw bundled spec selection through the shared operation; CLI-only, no envelope (P6 increment 1).",
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
      "The five evidence-query forms (style_query/style_diff/element_info/html_diff/html_query) run through the shared operation; CLI-only, no MCP tool (P7 verify increment).",
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
      "Git-tracked store enrichment through the shared operation; stays a deliberate human action, never a remotely triggered write (P6 increment 1).",
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
    reason: "Encrypted per-task auth-state listing; local-only (P6).",
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
      "Interactive device flow cannot be driven over MCP; one implementation serves both alias spellings (P6).",
  },
  logoutAccount: {
    id: "logoutAccount",
    mode: "local",
    requirement: "local-only",
    mapping: "missing",
    cli: ["logout", "auth logout"],
    mcpTools: [],
    operationFn: null,
    reason: "Local credential mutation; never an MCP tool (P6).",
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
      "Global telemetry opt-in/out config through the shared operation; CLI-only (P6 increment 1).",
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
    cli: ["push"],
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
      "Chat-only live-DOM read scoped to its session tab; read-only and approval-free, never a board write, with no CLI spelling and no main-manifest MCP tool (P7 chat increment).",
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
      "Chat-only server-side page-text fetch behind the bounded SSRF-guarded reader; read-only and approval-free, never a board write, with no CLI spelling and no main-manifest MCP tool (P7 chat increment).",
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
      "Stdio transport bootstrap, not a board tool; the CLI handler resolves the root, announces on stderr, and starts the transport through this operation (P7 server-lifecycle increment).",
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
      "Prototype/API-only server lifecycle through the shared operation; prototype viewer unpaired by design, kanban CLI routing remains (P7 server-lifecycle increment).",
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
 * each pointing at the operation that handles it (or will handle it after
 * its extraction phase — TEMPORARY_CLI_FLAGS marks the not-yet-routed
 * subset, and the ratchet asserts that subsetting). Shared flags (--title,
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
 * Empty since P5 (ticket 4a5f7df6): every P5 mode — standalone attach
 * (--attach/--move), delete (--delete/--yes), explicit commit
 * (--commit/--task/--message) and maintenance
 * (--normalize/--apply/--reindex-sort-keys) — routes through its shared
 * operation, so no bypass entries remain. Later phases re-add their own
 * entries here until their extraction lands.
 */
export const TEMPORARY_CLI_FLAGS: Record<
  string,
  { phase: string; reason: string }
> = {};

/** All operation ids, alphabetical — the registry's key order. */
export const OPERATION_IDS = Object.keys(OPERATION_REGISTRY).sort();
