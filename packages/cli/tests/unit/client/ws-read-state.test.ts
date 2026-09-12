import { describe, it, expect } from "vitest";

/**
 * The WebSocket `task-changed` handler in App.tsx rebuilds each task
 * field-by-field from the incoming payload. Per-user state (`openedBy`,
 * `expandedBy`) must survive those rebuilds — the board patches expandedBy
 * optimistically, and the server echo must not drop it.
 *
 * The mapping logic is replicated here as a pure function to stay
 * unit-testable; the real code lives in App.tsx `upsertTaskFromWs`.
 */

interface MinimalTask {
  id: string;
  openedBy?: string[];
  expandedBy?: string[];
}

function mapUserState(
  incoming: Record<string, unknown>,
  existing: MinimalTask | undefined,
): { openedBy?: string[]; expandedBy?: string[] } {
  return {
    openedBy: Array.isArray(incoming.openedBy)
      ? (incoming.openedBy as string[])
      : existing?.openedBy,
    expandedBy: Array.isArray(incoming.expandedBy)
      ? (incoming.expandedBy as string[])
      : existing?.expandedBy,
  };
}

describe("upsertTaskFromWs per-user state preservation", () => {
  it("uses incoming arrays when present", () => {
    const existing: MinimalTask = {
      id: "t1",
      openedBy: ["alice"],
      expandedBy: ["alice"],
    };
    const incoming = { id: "t1", openedBy: ["alice", "bob"], expandedBy: [] };
    expect(mapUserState(incoming, existing)).toEqual({
      openedBy: ["alice", "bob"],
      expandedBy: [],
    });
  });

  it("keeps existing state when the payload omits the fields", () => {
    const existing: MinimalTask = {
      id: "t1",
      openedBy: ["alice"],
      expandedBy: ["bob"],
    };
    expect(mapUserState({ id: "t1", title: "Renamed" }, existing)).toEqual({
      openedBy: ["alice"],
      expandedBy: ["bob"],
    });
  });

  it("yields undefined when neither side has state", () => {
    expect(mapUserState({ id: "t1" }, { id: "t1" })).toEqual({
      openedBy: undefined,
      expandedBy: undefined,
    });
  });
});
