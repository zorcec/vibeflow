/**
 * Operation surface contract — the machine-readable record of where the CLI
 * and MCP surfaces deliberately differ (P0, ticket 2d789b27).
 *
 * Pure data: no filesystem, no processes, no network. Importing this module
 * must never pull in anything beyond types — the same rule `mcp-tools.ts`
 * follows — so both the CLI registry and the hosted comparators can consume
 * it without dragging in a runtime.
 *
 * Every entry needs a `reason` and a `ticket`: an exception without a reason
 * is a hole that reads as reviewed. The operation-boundary ratchet
 * (`packages/cli/tests/unit/operation-boundary.test.ts`) asserts every entry
 * is still live (names a real operation/tool) — a stale entry fails exactly
 * like an unclassified divergence.
 */

/** Stable operation identities shared by every surface. */
export type OperationId =
  | "listTasks"
  | "getTask"
  | "getProject"
  | "createTask"
  | "updateTask"
  | "claimNextTask"
  | "addComment"
  | "attachFile"
  | "pullFromBoard"
  | "pushTasks"
  | "verifyTaskOp"
  | "inspectVerificationEvidence"
  | "startKanban"
  | "getIntegrationGuide"
  | "getAccountStatus"
  | "loginAccount"
  | "logoutAccount"
  | "linkCommitAuthors"
  | "manageTelemetry"
  | "listVerificationAuthState"
  | "clearVerificationAuthState"
  | "deleteTaskOperation"
  | "commitTaskPathsOperation"
  | "reindexTaskSortKeys"
  | "normalizeTaskStore"
  | "getChangelog"
  | "getOpenApiDocument"
  | "startServer"
  | "startMcpTransport"
  | "readPageText"
  | "readPageDom";

/** Where an operation can run. `both` means the same implementation serves
 * local and online backends (the mode decision lives below the surface). */
export type OperationMode = "local" | "online" | "both";

/**
 * Backend requirement per plan §1.4. `selected-board` operations resolve one
 * board and fail closed (never fall back to local files); `local-only`
 * operations stay local even with a token; `sync` bridges both; `none`
 * touches no task backend.
 */
export type BackendRequirement =
  | "selected-board"
  | "local-only"
  | "sync"
  | "none";

/** CLI↔MCP mapping for one operation. */
export type MappingKind = "one-to-one" | "intentionally-different" | "missing";

/** Surfaces that can carry an operation. */
export type SurfaceId =
  | "cli"
  | "local-mcp"
  | "local-http-mcp"
  | "agent-chat"
  | "hosted-mcp"
  | "api";

export interface SurfaceDelta {
  id: string;
  operation: OperationId;
  surfaces: readonly SurfaceId[];
  kind: "not-exposed" | "capability" | "wire-shape" | "input-policy";
  /** Precise differing paths/flags — never a free-form glob exemption. */
  fields?: readonly string[];
  reason: string;
  /** Executable assertion note: which test pins this delta. */
  expected: string;
  ticket: string;
}

export interface TemporaryMigrationEntry {
  /** CLI mode or handler still inline in `src/index.ts`. */
  handler: string;
  /** Phase that removes it (P1–P7). */
  removalPhase: string;
  ticket: string;
}

/**
 * Known intentional divergences (plan §3.3). Filtered-child scope and stale
 * local rows are NOT here — those are behavior corrections (P2), not
 * exceptions — and unused entries fail the ratchet.
 */
export const KNOWN_DELTAS: readonly SurfaceDelta[] = [
  {
    id: "push-mcp-absent",
    operation: "pushTasks",
    surfaces: ["local-mcp", "local-http-mcp", "agent-chat", "hosted-mcp"],
    kind: "not-exposed",
    reason:
      "The online sync stays a hidden CLI command: an agent-triggered whole-store push cannot be scoped or previewed per call, so no MCP tool exposes it. The drift gate pins the absence.",
    expected:
      "no manifest tool is named push_tasks; pushTasks stays CLI-only until the P6 service repair.",
    ticket: "2d789b27",
  },
  {
    id: "hosted-pull-absent",
    operation: "pullFromBoard",
    surfaces: ["hosted-mcp"],
    kind: "not-exposed",
    reason:
      "pull writes records into the caller's local store; a cloud runner has no project directory, so there is nothing to write to — absence, not a missing feature.",
    expected:
      "hosted tool list omits pull while the local manifest registers it (CLI_ONLY_MCP_TOOLS partition).",
    ticket: "2d789b27",
  },
  {
    id: "hosted-project-identity",
    operation: "getProject",
    surfaces: ["hosted-mcp"],
    kind: "capability",
    fields: ["root", "name", "branch"],
    reason:
      "Local get_project reports the startup-pinned project root/name/branch; the hosted runner has no checkout, so it reports the selected board identity instead.",
    expected:
      "hosted get_project answers board identity; local answers filesystem root. Compared as alternative responses, never as equal paths.",
    ticket: "2d789b27",
  },
  {
    id: "hosted-server-answers",
    operation: "startKanban",
    surfaces: ["hosted-mcp"],
    kind: "capability",
    reason:
      "Local start_kanban binds a listener and returns real URLs; hosted has no localhost to bind, so it returns a board deep link.",
    expected:
      "differential tests compare deep link vs listener as declared alternatives.",
    ticket: "2d789b27",
  },
  {
    id: "hosted-guide-answers",
    operation: "getIntegrationGuide",
    surfaces: ["hosted-mcp"],
    kind: "capability",
    reason:
      "Same split as startKanban: the hosted snippet names the board; the local guide names localhost URLs.",
    expected: "compared as alternative snippets for the same board.",
    ticket: "2d789b27",
  },
  {
    id: "hosted-verify-local-only",
    operation: "verifyTaskOp",
    surfaces: ["hosted-mcp"],
    kind: "capability",
    reason:
      "The verify engine reads local task/baseline files and drives a local browser; it cannot run against a cloud board, so hosted answers VERIFY_ENGINE_LOCAL_ONLY.",
    expected: "hosted verify_task refuses with the declared code; never silently passes.",
    ticket: "2d789b27",
  },
  {
    id: "hosted-update-no-checkout-git",
    operation: "updateTask",
    surfaces: ["hosted-mcp"],
    kind: "capability",
    reason:
      "The CLI review auto-commit links a local git SHA; the hosted runner has no checkout, so commit effects are absent there.",
    expected: "no hosted commit SHA is asserted; local auto-commit notices are CLI/local-only.",
    ticket: "2d789b27",
  },
  {
    id: "cli-mcp-transport-envelopes",
    operation: "listTasks",
    surfaces: ["cli", "local-mcp"],
    kind: "wire-shape",
    fields: ["ok", "task", "tasks", "notices", "content"],
    reason:
      "CLI tasks answers {ok:true,...namedPayload} on stdout; MCP answers raw operation data in content[0].text with sibling notices. Same data, different envelope — renderers map, operations do not standardize.",
    expected:
      "characterization pins each envelope; a renderer change fails its own surface test, not the shared operation.",
    ticket: "2d789b27",
  },
  {
    id: "verify-raw-result-envelope",
    operation: "verifyTaskOp",
    surfaces: ["cli"],
    kind: "wire-shape",
    fields: ["ok", "result"],
    reason:
      "verify --json prints the raw VerifyResult (whose ok is page-health evidence, not operation success), not {ok:true,result:...}; evidence-query forms have their own stdout shapes.",
    expected: "verify wire fixtures pin the raw shape; envelope uniformity needs a separately approved versioned change.",
    ticket: "2d789b27",
  },
  {
    id: "pull-push-bare-reports",
    operation: "pullFromBoard",
    surfaces: ["cli"],
    kind: "wire-shape",
    fields: ["ok", "board", "added", "merged"],
    reason:
      "pull/push --json print bare counters/reports (no ok:true wrapper); failures surface as flat {ok:false,code,...} on stdout for pull. Legacy shapes preserved through compatibility renderers.",
    expected: "pull/push wire fixtures pin the bare shapes.",
    ticket: "2d789b27",
  },
  {
    id: "status-human-text-envelope",
    operation: "getAccountStatus",
    surfaces: ["cli"],
    kind: "wire-shape",
    fields: ["--json"],
    reason:
      "status/auth status --json still prints the human summary text (the JSON flag predates a machine envelope); get_project is the machine-readable project probe.",
    expected: "status fixtures pin the human text; no MCP tool depends on a status JSON envelope.",
    ticket: "2d789b27",
  },
  {
    id: "attach-duplicate-policy",
    operation: "attachFile",
    surfaces: ["cli", "local-mcp"],
    kind: "input-policy",
    fields: ["--attach", "filename"],
    reason:
      "CLI standalone attach refuses a duplicate filename (keeps the source; --move only deletes after success); MCP attach_file replaces bytes in place. Same operation, explicit per-surface policy input.",
    expected:
      "duplicate tests pin refusal on CLI and replacement on MCP; P5 unifies behind an explicit onExisting input.",
    ticket: "2d789b27",
  },
  {
    id: "cli-only-unbounded-listing",
    operation: "listTasks",
    surfaces: ["cli"],
    kind: "capability",
    fields: ["--all", "nextCursor"],
    reason:
      "CLI --all pages internally for the whole scope; list_tasks deliberately has no unbounded mode (pages with nextCursor, capped limit). Unbounded MCP reads would bill context per call.",
    expected: "--all assembly stays CLI-only; hosted per-call ceiling is not treated as drift.",
    ticket: "2d789b27",
  },
  {
    id: "local-only-http-chat",
    operation: "listTasks",
    surfaces: ["local-http-mcp", "agent-chat"],
    kind: "capability",
    reason:
      "HTTP and agent-chat board tools mount only in the offline branch; online mode deliberately blocks local task routes (server.ts). Differential online coverage uses stdio MCP, never local HTTP.",
    expected: "online local-HTTP availability is not added to simplify tests.",
    ticket: "2d789b27",
  },
  {
    id: "chat-context-tools",
    operation: "inspectVerificationEvidence",
    surfaces: ["agent-chat"],
    kind: "not-exposed",
    fields: ["read_page_text", "read_page_dom"],
    reason:
      "Chat-only page-context tools (SSRF-bounded, approval-gated) are capabilities for the agent chat, not task operations; they get classified wrappers in P7 without weakening their security policy.",
    expected: "P7 gives them operation IDs; no CLI counterpart is added.",
    ticket: "2d789b27",
  },
  {
    id: "openapi-raw-document",
    operation: "getOpenApiDocument",
    surfaces: ["cli"],
    kind: "wire-shape",
    fields: ["--yaml"],
    reason:
      "openapi prints the raw bundled spec (JSON/YAML), not a CLI envelope; no server is required.",
    expected: "openapi fixtures pin the raw document output.",
    ticket: "2d789b27",
  },
  {
    id: "changelog-raw-text",
    operation: "getChangelog",
    surfaces: ["cli"],
    kind: "wire-shape",
    fields: ["--all"],
    reason:
      "changelog prints raw human text (latest/all); no JSON envelope is added.",
    expected: "changelog fixtures pin the raw text selection.",
    ticket: "2d789b27",
  },
];

/**
 * Temporary migration handlers (plan §4) — EMPTY since P8 (ticket dc9a42ac).
 *
 * Every handler listed here named a removal phase in P1–P7, and every one of
 * those phases has landed: reads (P2), claim (P3), remote writes (P4),
 * attachments/delete/commit/maintenance (P5), auxiliary/auth/sync (P6),
 * server lifecycle and verification (P7). The remaining inline call sites
 * are classified per call site in the CLI's SURFACE_STORAGE_USES (with the
 * owning operation named), not tracked as temporary migration — so this
 * list stays empty. The operation-boundary ratchet fails any re-added
 * entry, and the export itself is kept so external consumers keep
 * compiling.
 */
export const TEMPORARY_MIGRATION_ENTRIES: readonly TemporaryMigrationEntry[] = [];
