import { describe, it, expect } from "vitest";
import { mergeTaskFromPayload } from "../task-merge";
import type { Task, TaskLink } from "../types";

/**
 * Tests against the REAL WebSocket merge used by the kanban client
 * (`upsertTaskFromWs` in App.tsx delegates to `mergeTaskFromPayload`).
 *
 * The previous tests replicated the mapping as a local pure function, so they
 * passed no matter what the real code did — that is how the `verified` field
 * shipped dropped twice. Do not reintroduce local replicas.
 */

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Task",
    status: "todo",
    ...overrides,
  };
}

describe("mergeTaskFromPayload — verified semantics", () => {
  it("uses incoming.verified=true (the ticket-A frame)", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", verified: true },
      baseTask({ verified: false }),
    );
    expect(result.verified).toBe(true);
  });

  it("uses incoming.verified=false (explicit fail verdict)", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", verified: false },
      baseTask({ verified: true }),
    );
    expect(result.verified).toBe(false);
  });

  it("CLEARS the verdict when the frame omits verified (--set-verify cannot)", () => {
    // `cannot` writes verified=undefined and JSON.stringify drops the key, so
    // the frame arrives WITHOUT the key. Falling back to existing here would
    // leave a stale green badge until reload — the naive-fix trap.
    const result = mergeTaskFromPayload(
      { id: "t1", title: "Task" },
      baseTask({ verified: true }),
    );
    expect(result.verified).toBeUndefined();
  });

  it("claim reset: a frame with no verified key clears a stored true", () => {
    // Claiming a task resets the verdict (verify-attestation.ts).
    const result = mergeTaskFromPayload(
      { id: "t1", status: "in-progress" },
      baseTask({ status: "todo", verified: true }),
    );
    expect(result.verified).toBeUndefined();
    expect(result.status).toBe("in-progress");
  });
});

describe("mergeTaskFromPayload — commitPushed is GET-only", () => {
  it("preserves existing.commitPushed across a frame (never mapped from payload)", () => {
    // server.ts computes commitPushed only for GET responses; it never appears
    // in a WS payload. Mapping it from the payload would blank it every frame.
    const result = mergeTaskFromPayload(
      { id: "t1", title: "Task" },
      baseTask({ commitPushed: true }),
    );
    expect(result.commitPushed).toBe(true);
  });
});

describe("mergeTaskFromPayload — the nine previously-dropped fields", () => {
  it("maps branchName from the payload", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", branchName: "fix/bug-123" },
      baseTask(),
    );
    expect(result.branchName).toBe("fix/bug-123");
  });

  it("maps annotatedElementText from the payload", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", annotatedElementText: "Buy now" },
      baseTask(),
    );
    expect(result.annotatedElementText).toBe("Buy now");
  });

  it("maps authorName from the payload", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", authorName: "Tomislav" },
      baseTask(),
    );
    expect(result.authorName).toBe("Tomislav");
  });

  it("maps assigneeName from the payload", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", assigneeName: "Alice" },
      baseTask(),
    );
    expect(result.assigneeName).toBe("Alice");
  });

  it("maps agent from the payload", () => {
    const result = mergeTaskFromPayload({ id: "t1", agent: "opus" }, baseTask());
    expect(result.agent).toBe("opus");
  });

  it("maps model from the payload", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", model: "claude-opus-4" },
      baseTask(),
    );
    expect(result.model).toBe("claude-opus-4");
  });

  it("maps files from the payload (Array.isArray guarded)", () => {
    const files = [{ name: "paste-1.png", addedAt: "2026-01-01" }];
    const result = mergeTaskFromPayload({ id: "t1", files }, baseTask());
    expect(result.files).toEqual(files);
  });

  it("preserves existing files when the frame omits them", () => {
    const files = [{ name: "a.png" }];
    const result = mergeTaskFromPayload(
      { id: "t1", title: "Task" },
      baseTask({ files }),
    );
    expect(result.files).toEqual(files);
  });
});

describe("mergeTaskFromPayload — links preservation (kept from ws-links.test.ts)", () => {
  const parentId = "parent-aaa";

  it("uses incoming.links when present (replaces existing)", () => {
    const existing = baseTask({ links: [{ taskId: "old-parent", type: "parent" }] });
    const incoming = {
      id: "t1",
      title: "New",
      links: [{ taskId: parentId, type: "parent" }],
    };
    const result = mergeTaskFromPayload(incoming, existing);
    expect(result.links).toEqual([{ taskId: parentId, type: "parent" }]);
  });

  it("preserves existing.links when incoming omits links", () => {
    const links: TaskLink[] = [
      { taskId: parentId, type: "parent" },
      { taskId: "rel-1", type: "relates" },
    ];
    const result = mergeTaskFromPayload({ id: "t1", title: "Task" }, baseTask({ links }));
    expect(result.links).toEqual(links);
  });

  it("defaults to [] when neither has links", () => {
    const result = mergeTaskFromPayload({ id: "t1" }, undefined);
    expect(result.links).toEqual([]);
  });

  it("handles incoming.links as empty array (explicit clear)", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", links: [] },
      baseTask({ links: [{ taskId: parentId, type: "parent" }] }),
    );
    expect(result.links).toEqual([]);
  });

  it("regression: add blocks link → WS broadcast → link still present", () => {
    const existingAfterAdd = baseTask({ links: [{ taskId: parentId, type: "blocks" }] });
    const result = mergeTaskFromPayload(
      { id: "t1", title: "Blocked task" },
      existingAfterAdd,
    );
    expect(result.links).toEqual([{ taskId: parentId, type: "blocks" }]);
  });

  it("regression: add relates link → WS broadcast → link still present", () => {
    const existingAfterAdd = baseTask({ links: [{ taskId: parentId, type: "relates" }] });
    const result = mergeTaskFromPayload(
      { id: "t1", title: "Related task" },
      existingAfterAdd,
    );
    expect(result.links).toEqual([{ taskId: parentId, type: "relates" }]);
  });
});

describe("mergeTaskFromPayload — per-user state (kept from ws-read-state.test.ts)", () => {
  it("uses incoming arrays when present", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", openedBy: ["alice", "bob"], expandedBy: [] },
      baseTask({ openedBy: ["alice"], expandedBy: ["alice"] }),
    );
    expect(result.openedBy).toEqual(["alice", "bob"]);
    expect(result.expandedBy).toEqual([]);
  });

  it("keeps existing state when the payload omits the fields", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", title: "Renamed" },
      baseTask({ openedBy: ["alice"], expandedBy: ["bob"] }),
    );
    expect(result.openedBy).toEqual(["alice"]);
    expect(result.expandedBy).toEqual(["bob"]);
  });

  it("yields undefined when neither side has state", () => {
    const result = mergeTaskFromPayload({ id: "t1" }, baseTask());
    expect(result.openedBy).toBeUndefined();
    expect(result.expandedBy).toBeUndefined();
  });
});

describe("mergeTaskFromPayload — general behaviour", () => {
  it("prefers payload fields over existing and falls back per field", () => {
    const result = mergeTaskFromPayload(
      { id: "t1", title: "New title", status: "review" },
      baseTask({ title: "Old", status: "todo", file: "a.ts", line: 3 }),
    );
    expect(result.title).toBe("New title");
    expect(result.status).toBe("review");
    expect(result.file).toBe("a.ts");
    expect(result.line).toBe(3);
  });

  it("throws on a payload without an id (upsert caller already guards this)", () => {
    expect(() => mergeTaskFromPayload({}, undefined)).toThrow();
  });

  it("defaults title to Untitled and status to todo for a brand-new task", () => {
    const result = mergeTaskFromPayload({ id: "t2" }, undefined);
    expect(result.title).toBe("Untitled");
    expect(result.status).toBe("todo");
  });
});
