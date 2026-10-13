/**
 * Contract types for the /api/v1 Phase 0 harness.
 *
 * These mirror the shape of docs/api/v1-contract.json (the single source of
 * truth). The checked-in generated artifacts — openapi.yaml, openapi.json,
 * route-registry.gen.ts, openapi.gen.ts — are produced from that file by
 * scripts/gen-api-artifacts.mjs and must never be hand-edited.
 */

/** One v1 operation and where it lives on the local surface today. */
export interface V1Operation {
  /** Stable manifest/registry key, e.g. "list-tasks". */
  id: string;
  /** v1 HTTP method. */
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** v1 path, e.g. "/api/v1/tasks/{id}". */
  v1Path: string;
  /**
   * Current local handler, or null when no local HTTP handler exists
   * (claim-next, verify, export-prompt live in core/MCP only until Phase 3).
   */
  local: { method: string; path: string } | null;
  /** Required scope, or null for public reads (changelog). */
  scope: string | null;
  /** Row in plan §1.2. */
  planRow: number;
  summary: string;
  notes: string;
}

/** A local handler that is deliberately NOT a v1 operation. */
export interface LocalOnlyRoute {
  method: string;
  path: string;
  reason: string;
}

/** JSON domain type for normalized documents (normalizer boundary type). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Canonical status vocabulary (D6: local hyphenated set + accepted 'cancelled'). */
export const STATUS_VOCABULARY = [
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
  "cancelled",
] as const;

export type StatusVocabulary =
  (typeof STATUS_VOCABULARY)[number];

/** Comment author vocabulary (ledger L1: author is preserved, never rewritten). */
export const COMMENT_AUTHORS = ["user", "agent"] as const;

export type CommentAuthorVocabulary =
  (typeof COMMENT_AUTHORS)[number];

/** Fields that legitimately differ per run and are stripped before comparison. */
export const VOLATILE_TASK_FIELDS = [
  "created",
  "updated",
  "createdAt",
  "updatedAt",
  "sortKey",
  "commitPushed",
  "lastUsedAt",
] as const;
