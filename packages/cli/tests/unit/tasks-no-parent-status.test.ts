/**
 * Regression: clearing a task's parent link must never change its status.
 *
 * Reported symptom (task 3e9f447d): `tasks --edit <id> --no-parent` also set
 * the task status to `done`. No live defect was found — the CLI clear-parent
 * path in `src/index.ts` ("Parent link change (--set-parent / --no-parent)")
 * builds the update payload from title/setStatus/description plus `links`
 * only. Both `--no-parent` (`opts.parent === false`) and `--set-parent ""`
 * resolve to the same `parentId: null` branch, which computes the new links
 * via `buildSetParentLinks` and calls `updateTask(dir, id, { links })` with no
 * `status` field.
 *
 * These tests replay that exact composition against a temp store and lock the
 * invariant: only the parent link changes; status is preserved. They exist so
 * the reported symptom cannot regress silently.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSetParentLinks } from "../../src/core/task-links.js";
import {
  createTask,
  findTaskFilePath,
  listTasks,
  readTaskFile,
  updateTask,
} from "../../src/core/tasks.js";
import type { TaskStatus } from "../../src/core/types.js";

let projectDir: string;

/** Persisted parent link read straight from the task file on disk. */
function persistedParentId(taskId: string): string | undefined {
  const filePath = findTaskFilePath(projectDir, taskId);
  if (!filePath) return undefined;
  return readTaskFile(filePath)?.links?.find((l) => l.type === "parent")
    ?.taskId;
}

/** Persisted status read straight from the task file on disk. */
function persistedStatus(taskId: string): TaskStatus | undefined {
  const filePath = findTaskFilePath(projectDir, taskId);
  return filePath ? readTaskFile(filePath)?.status : undefined;
}

/** Seed a child task that already has a parent link and the given status. */
function seedChildWithParent(status: TaskStatus): {
  parentId: string;
  childId: string;
} {
  const parent = createTask(projectDir, {
    title: "Parent",
    description: "",
    status: "todo",
    selector: "/",
  });
  const child = createTask(projectDir, {
    title: "Child",
    description: "",
    status,
    selector: "/",
    links: [{ taskId: parent.id, type: "parent" }],
  });
  return { parentId: parent.id, childId: child.id };
}

/**
 * Replay the CLI's clear-parent branch: resolve the new links through
 * `buildSetParentLinks` and persist `links` only — never `status`. The CLI
 * passes `null` for both `--no-parent` (`opts.parent === false`) and
 * `--set-parent ""`; the helper also treats an empty string as clear.
 */
function clearParentViaCliPath(childId: string, parentId: null | ""): void {
  const cleared = buildSetParentLinks({
    allTasks: listTasks(projectDir),
    taskId: childId,
    parentId,
  });
  expect(cleared.ok).toBe(true);
  if (!cleared.ok) return;
  // The clear result carries links only — there is no status for the CLI to write.
  expect(cleared).not.toHaveProperty("status");
  updateTask(projectDir, childId, { links: cleared.links });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "no-parent-status-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('parent clear preserves status (--no-parent / --set-parent "")', () => {
  for (const status of ["todo", "in-progress"] as TaskStatus[]) {
    for (const flag of [
      { name: "--no-parent", parentId: null as null | "" },
      { name: '--set-parent ""', parentId: "" as null | "" },
    ]) {
      it(`${flag.name} clears the parent link and leaves status "${status}" unchanged`, () => {
        const { parentId, childId } = seedChildWithParent(status);
        expect(persistedParentId(childId)).toBe(parentId);
        expect(persistedStatus(childId)).toBe(status);

        clearParentViaCliPath(childId, flag.parentId);

        // Parent link is gone; status is exactly what it was before.
        expect(persistedParentId(childId)).toBeUndefined();
        expect(persistedStatus(childId)).toBe(status);
      });
    }
  }
});
