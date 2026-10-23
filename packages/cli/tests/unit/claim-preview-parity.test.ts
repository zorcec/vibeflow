/**
 * Preview/live claim parity (ticket 6452504d, parent e7482da5).
 *
 * The read-only preview (`LocalTaskStore.previewClaim`) must name the SAME
 * task the atomic primitive (`claimNextTaskAtomic`) takes from a reset
 * snapshot — and write nothing doing it. The top-blocked board below is the
 * characterized divergence: the old inline preview ignored unfinished
 * blockers and named the gated task while the live claim skipped it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalTaskStore } from "../../src/core/task-store.js";
import { claimNextTaskAtomic, listTasks } from "../../src/core/tasks.js";

const PROTO = ".vibeflow";
const TASKS_DIR = "tasks";

function writeTask(projectDir: string, task: Record<string, unknown>) {
  const dir = join(projectDir, PROTO, TASKS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${task.id as string}.json`),
    JSON.stringify(task, null, 2) + "\n",
  );
}

function task(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    title: `task ${id}`,
    description: "d",
    status: "todo",
    type: "Task",
    priority: "Medium",
    selector: "/",
    created: "2026-09-13T10:00:00.000Z",
    updated: "2026-09-13T10:00:00.000Z",
    id,
    ...overrides,
  };
}

describe("previewClaim matches claimNextTaskAtomic", () => {
  let dir: string;
  let store: LocalTaskStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preview-parity-"));
    store = new LocalTaskStore();
  });

  async function previewId(): Promise<string | null> {
    const preview = await store.previewClaim(dir);
    return preview?.task.id ?? null;
  }

  it("names the same task the live claim takes, and writes nothing", async () => {
    for (const t of [
      task("low", { priority: "Low" }),
      task("high", { priority: "High" }),
    ]) {
      writeTask(dir, t);
    }
    expect(await previewId()).toBe("high");
    // Still todo everywhere: the preview wrote nothing.
    expect(listTasks(dir).every((t) => t.status === "todo")).toBe(true);
    expect(claimNextTaskAtomic(dir)?.id).toBe("high");
  });

  it("skips a blocked top candidate in both paths (the fixed divergence)", async () => {
    for (const t of [
      task("gate", { status: "review" }),
      task("gated-top", {
        priority: "Critical",
        links: [{ taskId: "gate", type: "blocks" }],
      }),
      task("free-second", { priority: "High" }),
    ]) {
      writeTask(dir, t);
    }
    // The old inline preview named "gated-top" here while the live claim
    // took "free-second". One selector means both agree.
    expect(await previewId()).toBe("free-second");
    expect(claimNextTaskAtomic(dir)?.id).toBe("free-second");
  });

  it("child fallback agrees, with the same CHILD_CLAIM shape", async () => {
    for (const t of [
      task("epic", { status: "in-progress" }),
      task("live-child", {
        links: [{ taskId: "epic", type: "parent" }],
      }),
    ]) {
      writeTask(dir, t);
    }
    const preview = await store.previewClaim(dir);
    expect(preview?.task.id).toBe("live-child");
    expect(preview?.childClaim).toBe(true);
    expect(preview?.parentId).toBe("epic");
    expect(claimNextTaskAtomic(dir)?.id).toBe("live-child");
  });

  it("empty board previews null and claims null", async () => {
    expect(await store.previewClaim(dir)).toBeNull();
    expect(claimNextTaskAtomic(dir)).toBeNull();
  });
});
