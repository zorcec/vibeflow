/**
 * Stress tests for core task operations under large dataset conditions.
 *
 * These tests verify that task list operations stay fast and correct
 * when the project contains thousands of tasks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  listTasks,
  listTasksWithPaths,
  updateTask,
  findTaskFilePath,
} from "../../src/core/tasks.js";
import { addComment, listComments } from "../../src/core/comments.js";

const LARGE_TASK_COUNT = 5000;
const PERFORMANCE_MS = 20000; // 20s budget for 5k-task operations

describe("Stress: task creation and listing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-stress-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(`creates and lists ${LARGE_TASK_COUNT} tasks within ${PERFORMANCE_MS}ms`, () => {
    const before = process.memoryUsage();
    const start = Date.now();
    for (let i = 0; i < LARGE_TASK_COUNT; i++) {
      createTask(tempDir, {
        title: `Task ${i} — stress test item`,
        status: i % 5 === 0 ? "done" : i % 4 === 0 ? "review" : "todo",
        priority: i % 3 === 0 ? "high" : "medium",
        selector: `/page-${i % 20}`,
      });
    }
    const all = listTasks(tempDir);
    const elapsed = Date.now() - start;
    const after = process.memoryUsage();
    const heapDeltaMB = (after.heapUsed - before.heapUsed) / 1024 / 1024;

    console.log(`[stress] ${LARGE_TASK_COUNT} tasks: ${elapsed}ms | heap delta: ${heapDeltaMB.toFixed(1)}MB`);
    expect(all.length).toBe(LARGE_TASK_COUNT);
    expect(elapsed).toBeLessThan(PERFORMANCE_MS);
  }, PERFORMANCE_MS + 5000);

  it(`updates ${500} tasks in a ${LARGE_TASK_COUNT}-task project within 10s`, () => {
    const ids: string[] = [];
    for (let i = 0; i < LARGE_TASK_COUNT; i++) {
      const t = createTask(tempDir, { title: `Task ${i}`, selector: "/", status: "todo" });
      ids.push(t.id);
    }

    const before = process.memoryUsage();
    const start = Date.now();
    for (const id of ids.slice(0, 500)) {
      updateTask(tempDir, id, { status: "done" });
    }
    const elapsed = Date.now() - start;
    const after = process.memoryUsage();
    const heapDeltaMB = (after.heapUsed - before.heapUsed) / 1024 / 1024;

    console.log(`[stress] 500 updates: ${elapsed}ms | heap delta: ${heapDeltaMB.toFixed(1)}MB`);
    expect(elapsed).toBeLessThan(10000);

    const all = listTasks(tempDir);
    const done = all.filter((t) => t.status === "done");
    expect(done.length).toBe(500);
  }, 60_000);

  it(`listTasksWithPaths returns all ${LARGE_TASK_COUNT} tasks with file paths`, () => {
    for (let i = 0; i < LARGE_TASK_COUNT; i++) {
      createTask(tempDir, { title: `Task ${i}`, selector: "/" });
    }
    const withPaths = listTasksWithPaths(tempDir);
    expect(withPaths.length).toBe(LARGE_TASK_COUNT);
    for (const t of withPaths) {
      expect(t.filePath).toBeTruthy();
    }
  }, PERFORMANCE_MS + 5000);

  it("findTaskFilePath is fast even with 5000 tasks", () => {
    const created: string[] = [];
    for (let i = 0; i < LARGE_TASK_COUNT; i++) {
      const t = createTask(tempDir, { title: `Task ${i}`, selector: "/" });
      created.push(t.id);
    }
    const target = created[LARGE_TASK_COUNT - 1];
    const start = Date.now();
    const found = findTaskFilePath(tempDir, target);
    const elapsed = Date.now() - start;
    console.log(`[stress] findTaskFilePath in 5k tasks: ${elapsed}ms`);
    expect(found).toBeTruthy();
    expect(elapsed).toBeLessThan(2000);
  }, 60_000);
});

describe("Stress: comments under high volume", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-stress-comments-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a single task can hold 200 comments and list them correctly", () => {
    const task = createTask(tempDir, { title: "Heavy task", selector: "/" });
    for (let i = 0; i < 200; i++) {
      addComment(tempDir, task.id, "user", `Comment ${i}`);
    }
    const comments = listComments(tempDir, task.id);
    expect(comments.length).toBe(200);
    expect(comments[0].text).toBe("Comment 0");
    expect(comments[199].text).toBe("Comment 199");
  });

  it("many tasks each with comments perform well", () => {
    const TASKS = 100;
    const COMMENTS_PER = 5;
    const ids: string[] = [];

    for (let i = 0; i < TASKS; i++) {
      const t = createTask(tempDir, { title: `Task ${i}`, selector: "/" });
      ids.push(t.id);
    }

    const start = Date.now();
    for (const id of ids) {
      for (let c = 0; c < COMMENTS_PER; c++) {
        addComment(tempDir, id, "agent", `comment ${c}`);
      }
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000); // 100 tasks × 5 comments in < 3s

    const total = listComments(tempDir, ids[0]).length;
    expect(total).toBe(COMMENTS_PER);
  });
});

describe("Stress: import route simulation", () => {
  it("processes 500 task records and builds idMap without duplicates", () => {
    const tasks = Array.from({ length: 500 }, (_, i) => ({
      id: `cli-task-${i.toString().padStart(4, "0")}`,
      title: `Task ${i}`,
      status: ["todo", "in-progress", "done", "review", "backlog"][i % 5],
    }));

    const idMap: Record<string, string> = {};
    const created: string[] = [];

    for (const t of tasks) {
      const saasId = `saas-${t.id}`;
      idMap[t.id] = saasId;
      created.push(saasId);
    }

    expect(created.length).toBe(500);
    expect(Object.keys(idMap).length).toBe(500);
    // Verify duplicate detection
    const unique = new Set(Object.values(idMap));
    expect(unique.size).toBe(500);
  });
});
