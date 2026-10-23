/**
 * Versioned agent-claim request contract (ticket 6452504d, parent e7482da5).
 *
 * The ADDITIVE agent contract for `POST /api/v0/tasks/claim-next`. A request
 * carrying `agentVersion` runs the shared agent-claim selection (roots-first,
 * todo-only, priority/created order, unfinished-blocker and ancestry aware);
 * a request WITHOUT it keeps the exact legacy status semantics (including
 * `backlog`) and never enters the agent selector. The two shapes must never
 * be reinterpreted into each other — the version field is the discriminator.
 *
 * Rules, pinned by `tests/unit/agent-claim-contract.test.ts`:
 * - `agentVersion` is the literal `1` — an unknown version REJECTS (never a
 *   silent legacy fallback, which would claim under the wrong policy and
 *   report success for it).
 * - the object is `.strict()` — unknown fields REJECT (a misspelled filter
 *   must fail loudly, never claim the unfiltered board).
 * - filter vocabulary reuses the canonical MCP `ClaimNextTaskInput` spellings
 *   (`type`/`user`/`tag`/`dryRun`) — no synonyms.
 * - matching is EXACT (case-sensitive), the local contract: the online CLI
 *   used to case-fold type/user, but the claim path pins exact matching and
 *   any widening needs explicit approval (plan risk note, ticket 6452504d).
 */
import { z } from "zod";

/** The agent-claim protocol version the public client speaks. */
export const AGENT_CLAIM_VERSION = 1 as const;

/**
 * The versioned agent-claim body. `boardId` is the P2 frozen scope (the
 * once-per-call resolved board, never a guess); absent means the server's
 * default board, exactly as the unscoped legacy call behaves.
 */
export const AgentClaimRequest = z
  .object({
    agentVersion: z.literal(AGENT_CLAIM_VERSION),
    type: z
      .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
      .optional()
      .describe("Only claim a task of this type. Omit to claim across all types."),
    user: z
      .string()
      .optional()
      .describe(
        "Only claim a task assigned to this user (matched against the task author). Omit to claim anyone's work.",
      ),
    tag: z
      .array(z.string())
      .optional()
      .describe(
        "Only claim a task carrying every listed tag (AND). Omit for no tag filter.",
      ),
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        "Preview only: name the task that WOULD be claimed without moving it to in-progress.",
      ),
    boardId: z
      .string()
      .optional()
      .describe(
        "Board scope resolved once per call (P2 frozen scope). Omit for the server default.",
      ),
  })
  .strict();

export type AgentClaimRequestType = z.infer<typeof AgentClaimRequest>;

/** Filters the versioned body accepts, in MCP vocabulary (no synonyms). */
export interface AgentClaimFilters {
  type?: string;
  user?: string;
  tag?: string[];
  dryRun?: boolean;
}

/**
 * Build a versioned agent-claim body from MCP-vocabulary filters. The ONLY
 * constructor the public client uses — a hand-built literal could drift a
 * field name and `.strict()` would reject it server-side, so every sender
 * goes through here.
 */
export function buildAgentClaimRequest(
  filters: AgentClaimFilters,
  opts?: { boardId?: string },
): AgentClaimRequestType {
  return {
    agentVersion: AGENT_CLAIM_VERSION,
    ...(filters.type !== undefined ? { type: filters.type } : {}),
    ...(filters.user !== undefined ? { user: filters.user } : {}),
    ...(filters.tag !== undefined ? { tag: filters.tag } : {}),
    dryRun: filters.dryRun ?? false,
    ...(opts?.boardId !== undefined ? { boardId: opts.boardId } : {}),
  } as AgentClaimRequestType;
}

/**
 * Validate an inbound agent-claim body. Success carries the parsed request;
 * failure names the rejection (unknown version, unknown field, wrong shape)
 * so the server can refuse with a specific code instead of a catch-all.
 */
export function parseAgentClaimRequest(
  body: unknown,
):
  | { ok: true; request: AgentClaimRequestType }
  | { ok: false; message: string } {
  const parsed = AgentClaimRequest.safeParse(body);
  if (parsed.success) return { ok: true, request: parsed.data };
  const [first] = parsed.error.issues;
  return {
    ok: false,
    message: first
      ? `${first.path.join(".") || "(root)"}: ${first.message}`
      : "Invalid agent-claim request",
  };
}
