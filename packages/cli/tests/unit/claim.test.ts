import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── helpers ────────────────────────────────────────────────────────────────

const PROTO = ".vibeflow";
const TASKS_DIR = "tasks";

function taskJson(projectDir: string, id: string) {
  return join(projectDir, PROTO, TASKS_DIR, id + ".json");
}

function writeTask(projectDir: string, task: Record<string, unknown>) {
  const dir = join(projectDir, PROTO, TASKS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(taskJson(projectDir, task.id as string), JSON.stringify(task, null, 2) + "\n");
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("claimNextTaskAtomic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claim-test-"));
    // Import the real module (not mocked) for each test.
  });

  it("claims highest-priority todo task", async () => {
    const { claimNextTaskAtomic } = await import("../../src/core/tasks.js");

    writeTask(tmpDir, {
      id: "task-low",
      status: "todo",
      priority: "Low",
      title: "Low priority",
      created: "2026-01-01T00:00:00.000Z",
    });
    writeTask(tmpDir, {
      id: "task-high",
      status: "todo",
      priority: "High",
      title: "High priority",
      created: "2026-01-02T00:00:00.000Z",
    });

    const claimed = claimNextTaskAtomic(tmpDir);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe("task-high");
    expect(claimed!.status).toBe("in-progress");
  });

  it("returns null when no todo tasks", async () => {
    const { claimNextTaskAtomic } = await import("../../src/core/tasks.js");

    writeTask(tmpDir, {
      id: "task-done",
      status: "done",
      title: "Already done",
      created: "2026-01-01T00:00:00.000Z",
    });

    const claimed = claimNextTaskAtomic(tmpDir);
    expect(claimed).toBeNull();
  });

  it("sets author when provided", async () => {
    const { claimNextTaskAtomic } = await import("../../src/core/tasks.js");

    writeTask(tmpDir, {
      id: "task-1",
      status: "todo",
      title: "Test task",
      created: "2026-01-01T00:00:00.000Z",
    });

    const claimed = claimNextTaskAtomic(tmpDir, { author: "TestUser" });

    expect(claimed).not.toBeNull();
    expect(claimed!.author).toBe("TestUser");
  });

  it("does NOT overwrite author when author is undefined", async () => {
    const { claimNextTaskAtomic } = await import("../../src/core/tasks.js");

    writeTask(tmpDir, {
      id: "task-1",
      status: "todo",
      title: "Test task",
      author: "ExistingAuthor",
      created: "2026-01-01T00:00:00.000Z",
    });

    const claimed = claimNextTaskAtomic(tmpDir);

    expect(claimed).not.toBeNull();
    expect(claimed!.author).toBe("ExistingAuthor");
  });

  it("skips already-claimed tasks and picks next", async () => {
    const { claimNextTaskAtomic } = await import("../../src/core/tasks.js");

    writeTask(tmpDir, {
      id: "task-1",
      status: "in-progress",
      priority: "Critical",
      title: "Already claimed",
      created: "2026-01-01T00:00:00.000Z",
    });
    writeTask(tmpDir, {
      id: "task-2",
      status: "todo",
      priority: "High",
      title: "Next up",
      created: "2026-01-02T00:00:00.000Z",
    });

    const claimed = claimNextTaskAtomic(tmpDir);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe("task-2");
    expect(claimed!.status).toBe("in-progress");
  });

  it("filters by type", async () => {
    const { claimNextTaskAtomic } = await import("../../src/core/tasks.js");

    writeTask(tmpDir, {
      id: "task-feature",
      status: "todo",
      type: "Feature",
      title: "Feature task",
      created: "2026-01-01T00:00:00.000Z",
    });
    writeTask(tmpDir, {
      id: "task-bug",
      status: "todo",
      type: "Bug",
      priority: "Critical",
      title: "Bug task",
      created: "2026-01-02T00:00:00.000Z",
    });

    const claimed = claimNextTaskAtomic(tmpDir, { type: "Bug" });

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe("task-bug");
    expect(claimed!.type).toBe("Bug");
  });

  it("equal priority: older created wins", async () => {
    const { claimNextTaskAtomic } = await import("../../src/core/tasks.js");

    writeTask(tmpDir, {
      id: "task-newer",
      status: "todo",
      priority: "Medium",
      title: "Newer",
      created: "2026-01-05T00:00:00.000Z",
    });
    writeTask(tmpDir, {
      id: "task-older",
      status: "todo",
      priority: "Medium",
      title: "Older",
      created: "2026-01-01T00:00:00.000Z",
    });

    const claimed = claimNextTaskAtomic(tmpDir);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe("task-older");
  });

  it("second claim skips first task (already claimed by first call)", async () => {
    const { claimNextTaskAtomic } = await import("../../src/core/tasks.js");

    writeTask(tmpDir, {
      id: "task-1",
      status: "todo",
      priority: "High",
      title: "First",
      created: "2026-01-01T00:00:00.000Z",
    });
    writeTask(tmpDir, {
      id: "task-2",
      status: "todo",
      priority: "Medium",
      title: "Second",
      created: "2026-01-02T00:00:00.000Z",
    });

    const first = claimNextTaskAtomic(tmpDir);
    expect(first!.id).toBe("task-1");

    const second = claimNextTaskAtomic(tmpDir);
    expect(second!.id).toBe("task-2");

    // Third call — nothing left
    const third = claimNextTaskAtomic(tmpDir);
    expect(third).toBeNull();
  });
});
