import { describe, it, expect } from "vitest";
import type { TaskLink } from "@vibeflow-tools/ui/kanban";

/**
 * The WebSocket `task-changed` handler in App.tsx rebuilds each task
 * field-by-field from the incoming payload. These tests verify that the
 * `links` array is correctly preserved / replaced across the three
 * possible states:
 *   1. Incoming has links → use them
 *   2. Incoming omits links → keep existing
 *   3. Neither has links → default to []
 *
 * The mapping logic is replicated here as a pure function to stay
 * unit-testable; the real code lives in App.tsx `upsertTaskFromWs`.
 */

interface MinimalTask {
  id: string;
  title: string;
  links: TaskLink[];
}

/** Mirrors the link-preservation logic added to upsertTaskFromWs. */
function mapLinks(
  incoming: Record<string, unknown>,
  existing: MinimalTask | undefined,
): TaskLink[] {
  if (Array.isArray(incoming.links)) return incoming.links as TaskLink[];
  return existing?.links ?? [];
}

describe("upsertTaskFromWs link preservation", () => {
  const parentId = "parent-aaa";

  it("uses incoming.links when present (replaces existing)", () => {
    const existing: MinimalTask = {
      id: "t1",
      title: "Old",
      links: [{ taskId: "old-parent", type: "parent" }],
    };
    const incoming = {
      id: "t1",
      title: "New",
      links: [{ taskId: parentId, type: "parent" }],
    };

    const result = mapLinks(incoming, existing);
    expect(result).toEqual([{ taskId: parentId, type: "parent" }]);
    expect(result).not.toEqual(existing.links);
  });

  it("preserves existing.links when incoming omits links", () => {
    const existing: MinimalTask = {
      id: "t1",
      title: "Task",
      links: [
        { taskId: parentId, type: "parent" },
        { taskId: "rel-1", type: "relates" },
      ],
    };
    const incoming = { id: "t1", title: "Task" }; // no links

    const result = mapLinks(incoming, existing);
    expect(result).toEqual([
      { taskId: parentId, type: "parent" },
      { taskId: "rel-1", type: "relates" },
    ]);
  });

  it("defaults to [] when neither has links", () => {
    const result = mapLinks({ id: "t1" }, undefined);
    expect(result).toEqual([]);
  });

  it("handles incoming.links as empty array (explicit clear)", () => {
    const existing: MinimalTask = {
      id: "t1",
      title: "Task",
      links: [{ taskId: parentId, type: "parent" }],
    };
    const incoming = { id: "t1", links: [] };

    const result = mapLinks(incoming, existing);
    expect(result).toEqual([]);
  });

  it("regression: add blocks link → WS broadcast → link still present", () => {
    // Simulate: user adds a blocks link, then WS broadcasts the same task
    // back (without re-including links in the payload — the old bug).
    const existingAfterAdd: MinimalTask = {
      id: "t1",
      title: "Blocked task",
      links: [{ taskId: parentId, type: "blocks" }],
    };
    const wsBroadcast = { id: "t1", title: "Blocked task" }; // server omits links

    const result = mapLinks(wsBroadcast, existingAfterAdd);
    expect(result).toEqual([{ taskId: parentId, type: "blocks" }]);
  });

  it("regression: add relates link → WS broadcast → link still present", () => {
    const existingAfterAdd: MinimalTask = {
      id: "t1",
      title: "Related task",
      links: [{ taskId: parentId, type: "relates" }],
    };
    const wsBroadcast = { id: "t1", title: "Related task" };

    const result = mapLinks(wsBroadcast, existingAfterAdd);
    expect(result).toEqual([{ taskId: parentId, type: "relates" }]);
  });
});
