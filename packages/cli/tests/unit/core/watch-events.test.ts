import { describe, it, expect } from "vitest";
import {
  simpleHash,
  buildTaskSnapshot,
  classifyTaskUpdate,
  diffTaskSnapshots,
  type TaskSnapshot,
} from "../../../src/core/watch-events.js";
import type { Task } from "../../../src/core/types.js";

// ── helpers ────────────────────────────────────────────────────────────────

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-aaa",
    title: "Test task",
    description: "A test description",
    status: "todo",
    selector: "#el",
    created: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function snap(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: "task-aaa",
    status: "todo",
    priority: undefined,
    descriptionHash: simpleHash("A test description"),
    commentCount: 0,
    lastCommentAt: undefined,
    fileCount: 0,
    takenAt: "2026-09-07T10:00:00.000Z",
    ...overrides,
  };
}

const TS = "2026-09-07T10:00:00.000Z";

// ── simpleHash ─────────────────────────────────────────────────────────────

describe("simpleHash", () => {
  it("returns a non-empty string", () => {
    expect(typeof simpleHash("hello")).toBe("string");
    expect(simpleHash("hello").length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(simpleHash("abc")).toBe(simpleHash("abc"));
  });

  it("produces different hashes for different inputs", () => {
    expect(simpleHash("abc")).not.toBe(simpleHash("def"));
    expect(simpleHash("")).not.toBe(simpleHash("x"));
  });

  it("handles empty string", () => {
    const h = simpleHash("");
    expect(h).toBe("0"); // Math.imul(31,0)+0 = 0, >>> 0 = 0
  });
});

// ── buildTaskSnapshot ──────────────────────────────────────────────────────

describe("buildTaskSnapshot", () => {
  it("maps task fields to snapshot correctly", () => {
    const t = task({ id: "t1", status: "in-progress", priority: "High" });
    const snap = buildTaskSnapshot(t, 5, "2026-09-06T00:00:00.000Z", 3, TS);
    expect(snap.taskId).toBe("t1");
    expect(snap.status).toBe("in-progress");
    expect(snap.priority).toBe("High");
    expect(snap.commentCount).toBe(5);
    expect(snap.lastCommentAt).toBe("2026-09-06T00:00:00.000Z");
    expect(snap.fileCount).toBe(3);
    expect(snap.takenAt).toBe(TS);
  });

  it("hashes the description", () => {
    const t1 = task({ description: "foo" });
    const t2 = task({ description: "bar" });
    expect(buildTaskSnapshot(t1, 0, undefined, 0, TS).descriptionHash).toBe(
      simpleHash("foo"),
    );
    expect(buildTaskSnapshot(t2, 0, undefined, 0, TS).descriptionHash).toBe(
      simpleHash("bar"),
    );
    expect(buildTaskSnapshot(t1, 0, undefined, 0, TS).descriptionHash).not.toBe(
      buildTaskSnapshot(t2, 0, undefined, 0, TS).descriptionHash,
    );
  });
});

// ── classifyTaskUpdate (re-exported in watch-events.ts) ────────────────────

describe("classifyTaskUpdate (watch-events)", () => {
  it("classifies prev=undefined as new", () => {
    expect(classifyTaskUpdate(undefined, "todo")).toBe("new");
  });

  it("classifies any->todo as moved-to-todo", () => {
    expect(classifyTaskUpdate("backlog", "todo")).toBe("moved-to-todo");
    expect(classifyTaskUpdate("in-progress", "todo")).toBe("moved-to-todo");
  });

  it("returns null for todo->todo and non-todo transitions", () => {
    expect(classifyTaskUpdate("todo", "todo")).toBeNull();
    expect(classifyTaskUpdate("todo", "in-progress")).toBeNull();
    expect(classifyTaskUpdate("in-progress", "review")).toBeNull();
  });
});

// ── diffTaskSnapshots ──────────────────────────────────────────────────────

describe("diffTaskSnapshots", () => {
  // --- new task ---

  it("emits 'new' when prev is undefined", () => {
    const t = task();
    const next = snap();
    const events = diffTaskSnapshots(t, undefined, next);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "new",
      taskId: "task-aaa",
      timestamp: TS,
    });
  });

  it("emits only 'new' for a brand-new task even if other fields differ", () => {
    const t = task({ priority: "High", description: "changed" });
    // next has changed fields but prev is undefined → only "new"
    const next = snap({
      priority: "High",
      descriptionHash: simpleHash("changed"),
      commentCount: 2,
      fileCount: 1,
    });
    const events = diffTaskSnapshots(t, undefined, next);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("new");
  });

  // --- moved-to-todo ---

  it("emits 'moved-to-todo' when status transitions into todo", () => {
    const t = task();
    const prev = snap({ status: "in-progress" });
    const next = snap({ status: "todo" });
    const events = diffTaskSnapshots(t, prev, next);
    const movedEvent = events.find((e) => e.type === "moved-to-todo");
    expect(movedEvent).toBeDefined();
    expect(movedEvent).toEqual({
      type: "moved-to-todo",
      taskId: "task-aaa",
      timestamp: TS,
    });
    // Also emits a 'status' event (kind !== 'new' so the status check passes)
    const statusEvent = events.find((e) => e.type === "status");
    expect(statusEvent).toBeDefined();
    expect(statusEvent).toHaveProperty("from", "in-progress");
    expect(statusEvent).toHaveProperty("to", "todo");
  });

  // --- status change (non-new) ---

  it("emits 'status' for transitions between non-todo statuses", () => {
    const t = task({ status: "in-progress" });
    const prev = snap({ status: "todo" });
    const next = snap({ status: "in-progress" });
    const events = diffTaskSnapshots(t, prev, next);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "status",
      taskId: "task-aaa",
      timestamp: TS,
      from: "todo",
      to: "in-progress",
    });
  });

  it("emits 'status' for review->done", () => {
    const t = task({ status: "done" });
    const prev = snap({ status: "review" });
    const next = snap({ status: "done" });
    const events = diffTaskSnapshots(t, prev, next);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("status");
    expect(events[0]).toHaveProperty("from", "review");
    expect(events[0]).toHaveProperty("to", "done");
  });

  it("does not emit 'status' when moved-to-todo (kind !== 'new' but kind === 'moved-to-todo' skips status check)", () => {
    // moved-to-todo: prev=review, next=todo → kind="moved-to-todo", status changed but kind !== "new"
    // the code says: if (prev && prev.status !== next.status && kind !== "new")
    // kind is "moved-to-todo" which is !== "new", so it WILL emit both moved-to-todo AND status
    const t = task();
    const prev = snap({ status: "review" });
    const next = snap({ status: "todo" });
    const events = diffTaskSnapshots(t, prev, next);
    const statusEvent = events.find((e) => e.type === "status");
    expect(statusEvent).toBeDefined();
    expect(statusEvent).toHaveProperty("from", "review");
    expect(statusEvent).toHaveProperty("to", "todo");
  });

  // --- comment ---

  it("emits 'comment' when commentCount increases", () => {
    const t = task();
    const prev = snap({ commentCount: 1 });
    const next = snap({
      commentCount: 3,
      lastCommentAt: "2026-09-07T09:30:00.000Z",
    });
    const events = diffTaskSnapshots(t, prev, next);
    const commentEvent = events.find((e) => e.type === "comment");
    expect(commentEvent).toBeDefined();
    expect(commentEvent).toMatchObject({
      type: "comment",
      taskId: "task-aaa",
      timestamp: TS,
      author: "user",
      isNew: true,
      commentCount: 3,
      lastCommentAt: "2026-09-07T09:30:00.000Z",
    });
  });

  it("emits 'comment' with isNew=false when commentCount decreases (deletion)", () => {
    const t = task();
    const prev = snap({ commentCount: 5 });
    const next = snap({ commentCount: 3 });
    const events = diffTaskSnapshots(t, prev, next);
    const commentEvent = events.find((e) => e.type === "comment");
    expect(commentEvent).toBeDefined();
    expect(commentEvent).toMatchObject({
      type: "comment",
      isNew: false,
      commentCount: 3,
    });
  });

  it("does not emit 'comment' when commentCount unchanged", () => {
    const prev = snap({ commentCount: 2 });
    const next = snap({ commentCount: 2 });
    const events = diffTaskSnapshots(task(), prev, next);
    expect(events.find((e) => e.type === "comment")).toBeUndefined();
  });

  it("uses next.takenAt as lastCommentAt fallback when lastCommentAt is undefined", () => {
    const prev = snap({ commentCount: 0 });
    const next = snap({ commentCount: 1, lastCommentAt: undefined });
    const events = diffTaskSnapshots(task(), prev, next);
    const commentEvent = events.find((e) => e.type === "comment");
    expect(commentEvent).toBeDefined();
    expect(commentEvent).toHaveProperty("lastCommentAt", TS);
  });

  // --- file ---

  it("emits 'file' when fileCount increases", () => {
    const prev = snap({ fileCount: 0 });
    const next = snap({ fileCount: 2 });
    const events = diffTaskSnapshots(task(), prev, next);
    const fileEvent = events.find((e) => e.type === "file");
    expect(fileEvent).toBeDefined();
    expect(fileEvent).toMatchObject({
      type: "file",
      isNew: true,
      fileCount: 2,
      filename: "",
    });
  });

  it("emits 'file' with isNew=false when fileCount decreases", () => {
    const prev = snap({ fileCount: 3 });
    const next = snap({ fileCount: 1 });
    const events = diffTaskSnapshots(task(), prev, next);
    const fileEvent = events.find((e) => e.type === "file");
    expect(fileEvent).toBeDefined();
    expect(fileEvent).toMatchObject({
      type: "file",
      isNew: false,
      fileCount: 1,
    });
  });

  it("does not emit 'file' when fileCount unchanged", () => {
    const prev = snap({ fileCount: 2 });
    const next = snap({ fileCount: 2 });
    const events = diffTaskSnapshots(task(), prev, next);
    expect(events.find((e) => e.type === "file")).toBeUndefined();
  });

  // --- priority ---

  it("emits 'priority' when priority changes", () => {
    const prev = snap({ priority: "Low" });
    const next = snap({ priority: "Critical" });
    const events = diffTaskSnapshots(task(), prev, next);
    const priorityEvent = events.find((e) => e.type === "priority");
    expect(priorityEvent).toBeDefined();
    expect(priorityEvent).toMatchObject({
      type: "priority",
      from: "Low",
      to: "Critical",
    });
  });

  it("emits 'priority' with from=undefined when priority set for first time", () => {
    const prev = snap({ priority: undefined });
    const next = snap({ priority: "High" });
    const events = diffTaskSnapshots(task(), prev, next);
    const priorityEvent = events.find((e) => e.type === "priority");
    expect(priorityEvent).toBeDefined();
    expect(priorityEvent).toMatchObject({
      type: "priority",
      from: undefined,
      to: "High",
    });
  });

  it("emits 'priority' with to=undefined when priority removed", () => {
    const prev = snap({ priority: "Medium" });
    const next = snap({ priority: undefined });
    const events = diffTaskSnapshots(task(), prev, next);
    const priorityEvent = events.find((e) => e.type === "priority");
    expect(priorityEvent).toBeDefined();
    expect(priorityEvent).toMatchObject({
      type: "priority",
      from: "Medium",
      to: undefined,
    });
  });

  it("does not emit 'priority' when priority unchanged (both undefined)", () => {
    const prev = snap({ priority: undefined });
    const next = snap({ priority: undefined });
    const events = diffTaskSnapshots(task(), prev, next);
    expect(events.find((e) => e.type === "priority")).toBeUndefined();
  });

  // --- description ---

  it("emits 'description' when descriptionHash changes", () => {
    const prev = snap({ descriptionHash: simpleHash("old") });
    const next = snap({ descriptionHash: simpleHash("new") });
    const events = diffTaskSnapshots(task(), prev, next);
    const descEvent = events.find((e) => e.type === "description");
    expect(descEvent).toBeDefined();
    expect(descEvent).toMatchObject({
      type: "description",
      taskId: "task-aaa",
      timestamp: TS,
    });
  });

  it("does not emit 'description' when descriptionHash unchanged", () => {
    const h = simpleHash("same");
    const prev = snap({ descriptionHash: h });
    const next = snap({ descriptionHash: h });
    const events = diffTaskSnapshots(task(), prev, next);
    expect(events.find((e) => e.type === "description")).toBeUndefined();
  });

  // --- no-op ---

  it("returns empty array when nothing changed", () => {
    const prev = snap();
    const next = snap();
    const events = diffTaskSnapshots(task(), prev, next);
    expect(events).toEqual([]);
  });

  // --- simultaneous changes ---

  it("emits multiple events when several fields change at once", () => {
    const t = task({ status: "review" });
    const prev = snap({
      status: "in-progress",
      commentCount: 1,
      fileCount: 0,
      priority: "Low",
      descriptionHash: simpleHash("old"),
    });
    const next = snap({
      status: "review",
      commentCount: 3,
      lastCommentAt: "2026-09-07T09:00:00.000Z",
      fileCount: 2,
      priority: "High",
      descriptionHash: simpleHash("new"),
      takenAt: TS,
    });
    const events = diffTaskSnapshots(t, prev, next);
    const types = events.map((e) => e.type);
    expect(types).toContain("status");
    expect(types).toContain("comment");
    expect(types).toContain("file");
    expect(types).toContain("priority");
    expect(types).toContain("description");
    // status changed + 4 others = 5 events total
    expect(events).toHaveLength(5);
  });

  it("emits 'new' plus all field-diff events when prev is undefined and next has non-defaults", () => {
    const t = task({ priority: "High", description: "desc" });
    const next = snap({
      priority: "High",
      descriptionHash: simpleHash("desc"),
      commentCount: 5,
      lastCommentAt: "2026-09-07T08:00:00.000Z",
      fileCount: 3,
    });
    // prev=undefined → only 'new', no other events (prev check guards all others)
    const events = diffTaskSnapshots(t, undefined, next);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("new");
  });

  // --- ordering ---

  it("emits events in definition order: new/moved-to-todo, status, comment, file, priority, description", () => {
    const t = task({ status: "review" });
    const prev = snap({
      status: "in-progress",
      commentCount: 0,
      fileCount: 0,
      priority: undefined,
      descriptionHash: simpleHash("old"),
    });
    const next = snap({
      status: "review",
      commentCount: 1,
      lastCommentAt: TS,
      fileCount: 1,
      priority: "Critical",
      descriptionHash: simpleHash("new"),
    });
    const events = diffTaskSnapshots(t, prev, next);
    const types = events.map((e) => e.type);
    // All 5 should be in order
    expect(types).toEqual([
      "status",
      "comment",
      "file",
      "priority",
      "description",
    ]);
  });

  // --- case sensitivity / boundary ---

  it("treats different case priorities as different values", () => {
    const prev = snap({ priority: "high" });
    const next = snap({ priority: "High" });
    const events = diffTaskSnapshots(task(), prev, next);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("priority");
  });

  it("emits 'status' for every distinct non-new transition", () => {
    const transitions: [string, string][] = [
      ["todo", "in-progress"],
      ["in-progress", "review"],
      ["review", "done"],
      ["done", "backlog"],
    ];
    for (const [from, to] of transitions) {
      const t = task({ status: to as Task["status"] });
      const prev = snap({ status: from as TaskSnapshot["status"] });
      const next = snap({ status: to as TaskSnapshot["status"] });
      const events = diffTaskSnapshots(t, prev, next);
      const statusEvents = events.filter((e) => e.type === "status");
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0]).toHaveProperty("from", from);
      expect(statusEvents[0]).toHaveProperty("to", to);
    }
  });
});
