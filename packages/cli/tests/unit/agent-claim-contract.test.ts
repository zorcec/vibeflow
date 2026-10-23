/**
 * Agent-claim contract regressions (ticket 6452504d, parent e7482da5).
 *
 * The additive versioned body for `POST /api/v0/tasks/claim-next`:
 * - `agentVersion: 1` is the discriminator — unknown versions REJECT (never
 *   a silent legacy fallback that would claim under the wrong policy);
 * - the object is `.strict()` — unknown fields REJECT (a misspelled filter
 *   must fail loudly, never claim the unfiltered board);
 * - a body WITHOUT the version is not an agent request at all (legacy
 *   status semantics, including `backlog`, are preserved exactly and never
 *   reinterpreted into the agent selector);
 * - filters reuse the canonical MCP vocabulary (`type`/`user`/`tag`/
 *   `dryRun`) and match EXACTLY — no case-folding without explicit approval.
 */
import { describe, it, expect } from "vitest";
import {
  AGENT_CLAIM_VERSION,
  AgentClaimRequest,
  buildAgentClaimRequest,
  parseAgentClaimRequest,
} from "@vibeflow-tools/api-core";

describe("agent-claim contract", () => {
  it("pins the protocol version to 1", () => {
    expect(AGENT_CLAIM_VERSION).toBe(1);
  });

  it("builds the exact versioned body from MCP-vocabulary filters", () => {
    expect(buildAgentClaimRequest({})).toEqual({
      agentVersion: 1,
      dryRun: false,
    });
    expect(
      buildAgentClaimRequest(
        { type: "Bug", user: "zoe", tag: ["x", "y"], dryRun: true },
        { boardId: "board-1" },
      ),
    ).toEqual({
      agentVersion: 1,
      type: "Bug",
      user: "zoe",
      tag: ["x", "y"],
      dryRun: true,
      boardId: "board-1",
    });
  });

  it("accepts a valid versioned body", () => {
    const parsed = parseAgentClaimRequest(
      buildAgentClaimRequest({ type: "Task" }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.request.agentVersion).toBe(1);
  });

  it("rejects an unknown agent version (never a silent legacy fallback)", () => {
    expect(
      parseAgentClaimRequest({ agentVersion: 2, dryRun: false }).ok,
    ).toBe(false);
    expect(
      parseAgentClaimRequest({ agentVersion: 0, dryRun: false }).ok,
    ).toBe(false);
  });

  it("rejects unknown fields (strict — a misspelled filter fails loudly)", () => {
    expect(
      parseAgentClaimRequest({
        agentVersion: 1,
        dryRun: false,
        usre: "zoe",
      }).ok,
    ).toBe(false);
  });

  it("does not reinterpret a versionless body as an agent request", () => {
    // Legacy callers send status-scoped bodies with no version — including
    // `backlog`. Absence of the version means \"not an agent request\", so
    // parsing it as one must fail and the legacy path keeps its semantics.
    expect(
      parseAgentClaimRequest({ status: "backlog", dryRun: false }).ok,
    ).toBe(false);
    expect(parseAgentClaimRequest({}).ok).toBe(false);
  });

  it("rejects wrong-shape filters instead of guessing", () => {
    expect(
      parseAgentClaimRequest({ agentVersion: 1, tag: "x" }).ok,
    ).toBe(false);
    expect(
      parseAgentClaimRequest({ agentVersion: 1, type: "Nope" }).ok,
    ).toBe(false);
  });

  it("the schema itself is strict", () => {
    // Belt and braces: the zod schema the manifest/server share rejects
    // unknown keys on its own, not only through the parse helper.
    expect(
      AgentClaimRequest.safeParse({
        agentVersion: 1,
        dryRun: false,
        status: "todo",
      }).success,
    ).toBe(false);
  });
});
