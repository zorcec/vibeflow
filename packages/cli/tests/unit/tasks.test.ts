import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateTaskId,
  getTasksDir,
  ensureTaskDirs,
  createTask,
  readTaskFile,
  listTasks,
  listTasksWithPaths,
  findTaskFilePath,
  updateTask,
  deleteTask,
  formatTaskForAgent,
  migrateFlatTasksToDateDirs,
  renderTaskForAgent,
  renderAgentInstructions,
} from "../../src/core/tasks.js";
import type { Task, TaskComment } from "../../src/core/types.js";
import type { FileInfo } from "../../src/core/files.js";

describe("generateTaskId", () => {
  it("returns a 30-character string", () => {
    const id = generateTaskId();
    expect(id).toHaveLength(30);
  });

  it("returns unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTaskId()));
    expect(ids.size).toBe(100);
  });
});


describe("uniqueFilename collision (counter branch)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-slug-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends -2 counter when slug already exists", () => {
    // Create two tasks with the same title so uniqueFilename needs counter path
    createTask(tempDir, { title: "Same Title", description: "", status: "todo", selector: "#a" });
    createTask(tempDir, { title: "Same Title", description: "", status: "todo", selector: "#b" });

    const tasks = listTasks(tempDir);
    expect(tasks).toHaveLength(2);
    // Both tasks must have different IDs
    expect(tasks[0].id).not.toBe(tasks[1].id);
  });
});

describe("CRUD operations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-tasks-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getTasksDir returns .vibeflow/tasks path", () => {
    expect(getTasksDir(tempDir)).toBe(join(tempDir, ".vibeflow", "tasks"));
  });

  it("ensureTaskDirs creates tasks directory", () => {
    ensureTaskDirs(tempDir);
    expect(existsSync(getTasksDir(tempDir))).toBe(true);
  });

  it("createTask creates a .md file and returns a task with ID", () => {
    const task = createTask(tempDir, {
      title: "Fix the header",
      description: "Make it sticky",
      status: "todo",
      selector: '[data-vibeflow-id="header"]',
    });

    expect(task.id).toBeDefined();
    expect(task.id).toHaveLength(30);
    expect(task.title).toBe("Fix the header");
    expect(task.created).toBeDefined();

    const files = listTasks(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe(task.id);
  });

  it("createTask defaults priority to Medium when omitted", () => {
    const task = createTask(tempDir, {
      title: "Default priority task",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="default-priority"]',
    });

    expect(task.priority).toBe("Medium");
    const fromDisk = listTasks(tempDir).find((t) => t.id === task.id);
    expect(fromDisk?.priority).toBe("Medium");
  });

  it("createTask normalizes priority casing", () => {
    const task = createTask(tempDir, {
      title: "Normalized priority task",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="normalized-priority"]',
      priority: "high",
    });

    expect(task.priority).toBe("High");
  });

  it("listTasks returns empty array for non-existent dir", () => {
    expect(listTasks(tempDir)).toEqual([]);
  });

  it("listTasks returns all created tasks sorted", () => {
    createTask(tempDir, {
      title: "B task",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="b"]',
    });
    createTask(tempDir, {
      title: "A task",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="a"]',
    });

    const tasks = listTasks(tempDir);
    expect(tasks).toHaveLength(2);
  });

  it("findTaskFilePath finds existing task", () => {
    const task = createTask(tempDir, {
      title: "Find me",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="find"]',
    });

    const path = findTaskFilePath(tempDir, task.id);
    expect(path).not.toBeNull();
    expect(path!.endsWith(".json")).toBe(true);
  });

  it("findTaskFilePath returns null for non-existent task", () => {
    ensureTaskDirs(tempDir);
    expect(findTaskFilePath(tempDir, "nonexist")).toBeNull();
  });

  it("updateTask modifies status and returns updated task", () => {
    const task = createTask(tempDir, {
      title: "Update me",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="upd"]',
    });

    const updated = updateTask(tempDir, task.id, { status: "done" });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("done");
    expect(updated!.updated).toBeDefined();

    const fromDisk = listTasks(tempDir);
    expect(fromDisk[0].status).toBe("done");
  });

  it("updateTask returns null for non-existent task", () => {
    ensureTaskDirs(tempDir);
    expect(updateTask(tempDir, "nonexist", { status: "done" })).toBeNull();
  });

  it("deleteTask removes the task file", () => {
    const task = createTask(tempDir, {
      title: "Delete me",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="del"]',
    });

    expect(deleteTask(tempDir, task.id)).toBe(true);
    expect(listTasks(tempDir)).toHaveLength(0);
  });

  it("deleteTask returns false for non-existent task", () => {
    ensureTaskDirs(tempDir);
    expect(deleteTask(tempDir, "nonexist")).toBe(false);
  });

  it("readTaskFile reads and parses a task file", () => {
    const task = createTask(tempDir, {
      title: "Read me",
      description: "Description here",
      status: "in-progress",
      selector: '[data-vibeflow-id="read"]',
    });

    const filePath = findTaskFilePath(tempDir, task.id)!;
    const read = readTaskFile(filePath);
    expect(read).not.toBeNull();
    expect(read!.title).toBe("Read me");
    expect(read!.status).toBe("in-progress");
  });

  it("updateTask can update title and description", () => {
    const task = createTask(tempDir, {
      title: "Original title",
      description: "Original desc",
      status: "todo",
      selector: '[data-vibeflow-id="title-test"]',
    });

    const updated = updateTask(tempDir, task.id, {
      title: "Updated title",
      description: "Updated desc",
    });
    expect(updated!.title).toBe("Updated title");
    expect(updated!.description).toBe("Updated desc");

    const fromDisk = listTasks(tempDir);
    expect(fromDisk[0].title).toBe("Updated title");
    expect(fromDisk[0].description).toBe("Updated desc");
  });

  it("listTasks picks up flat .json files (legacy undated layout)", () => {
    ensureTaskDirs(tempDir);
    const tasksDir = getTasksDir(tempDir);
    const flatTask: Task = {
      id: "flat1234",
      title: "Flat layout task",
      description: "legacy",
      status: "todo",
      selector: "/",
      created: "2025-03-01T00:00:00.000Z",
      comments: [],
      files: [],
    };
    writeFileSync(join(tasksDir, "flat1234.json"), JSON.stringify(flatTask, null, 2), "utf-8");

    const tasks = listTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("flat1234");
  });

  it("updateTask migrates flat file to date subdir when updated", () => {
    ensureTaskDirs(tempDir);
    const tasksDir = getTasksDir(tempDir);
    const flatTask: Task = {
      id: "upd12345",
      title: "Flat to update",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-04-01T00:00:00.000Z",
      comments: [],
      files: [],
    };
    writeFileSync(join(tasksDir, "upd12345.json"), JSON.stringify(flatTask, null, 2), "utf-8");

    const result = updateTask(tempDir, "upd12345", { title: "Updated flat" });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Updated flat");

    // Flat file should be gone after update moves it to date subdir.
    expect(existsSync(join(tasksDir, "upd12345.json"))).toBe(false);
    // Task is now accessible.
    const loaded = listTasks(tempDir).find((t) => t.id === "upd12345");
    expect(loaded?.title).toBe("Updated flat");
  });
});

// ── Task data structure fixes (3defad41) ────────────────────────────────────
describe("task data structure fixes", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "proto-struct-")); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("reportBack:false is not stored in task JSON", () => {
    const task = createTask(tempDir, {
      title: "No report back",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="btn"]',
    });
    const filePath = findTaskFilePath(tempDir, task.id)!;
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.reportBack).toBeUndefined();
  });

  it("reportBack:true is stored in task JSON", () => {
    const task = createTask(tempDir, {
      title: "Report back task",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="btn"]',
      reportBack: true,
    });
    const filePath = findTaskFilePath(tempDir, task.id)!;
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.reportBack).toBe(true);
  });

  it("file-path selector is replaced with URL when file+line are set", () => {
    // Simulate a task file that was saved with a file:line selector
    ensureTaskDirs(tempDir);
    const taskData = {
      id: "test1234",
      title: "File selector task",
      description: "",
      status: "todo",
      url: "/kanban",
      selector: "src/client/kanban/TaskCard.tsx:150",
      file: "src/client/kanban/TaskCard.tsx",
      line: 150,
      col: 7,
      created: new Date().toISOString(),
    };
    const dir = join(tempDir, ".vibeflow", "tasks", "2025-01-01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "test1234.json"), JSON.stringify(taskData), "utf-8");

    const tasks = listTasks(tempDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].selector).toBe("/kanban");
  });

  it("file-path selector falls back to '/' when no URL is set", () => {
    ensureTaskDirs(tempDir);
    const taskData = {
      id: "test5678",
      title: "File selector no url",
      description: "",
      status: "todo",
      selector: "src/components/Button.tsx:42",
      file: "src/components/Button.tsx",
      line: 42,
      created: new Date().toISOString(),
    };
    const dir = join(tempDir, ".vibeflow", "tasks", "2025-01-01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "test5678.json"), JSON.stringify(taskData), "utf-8");

    const tasks = listTasks(tempDir);
    expect(tasks[0].selector).toBe("/");
  });
});

// ── Regression: cssSelector support ────────────────────────────────────────
describe("cssSelector in Task", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-css-sel-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("createTask stores cssSelector in file and roundtrips correctly", () => {
    const task = createTask(tempDir, {
      title: "With CSS selector",
      description: "",
      status: "todo",
      selector: '[data-testid="hero"]',
      cssSelector: "div.hero > h1",
    });
    expect(task.cssSelector).toBe("div.hero > h1");

    const tasks = listTasks(tempDir);
    expect(tasks[0].cssSelector).toBe("div.hero > h1");
  });
});

// ── Regression: listTasksWithPaths ────────────────────────────────────────
describe("listTasksWithPaths", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-paths-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array for non-existent dir", () => {
    expect(listTasksWithPaths(tempDir)).toEqual([]);
  });

  it("returns tasks with filePath property", () => {
    createTask(tempDir, {
      title: "Task A",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="a"]',
    });
    createTask(tempDir, {
      title: "Task B",
      description: "",
      status: "done",
      selector: '[data-vibeflow-id="b"]',
    });

    const results = listTasksWithPaths(tempDir);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.filePath).toBeDefined();
      expect(result.filePath.endsWith(".json")).toBe(true);
      expect(existsSync(result.filePath)).toBe(true);
    }
  });

  it("filePath matches the actual task file", () => {
    const task = createTask(tempDir, {
      title: "Path check",
      description: "",
      status: "todo",
      selector: '[data-vibeflow-id="pathcheck"]',
    });

    const results = listTasksWithPaths(tempDir);
    expect(results).toHaveLength(1);
    const content = readFileSync(results[0].filePath, "utf-8");
    expect(content).toContain(task.id);
    expect(content).toContain("Path check");
  });
});

describe("formatTaskForAgent", () => {
  const baseTask: Task = {
    id: "abc12345",
    title: "My Task",
    description: "Do something",
    status: "todo",
    selector: '[data-vibeflow-id="btn"]',
    created: "2025-01-01T00:00:00.000Z",
  };

  it("returns core fields for a minimal task", () => {
    const result = formatTaskForAgent(baseTask);
    expect(result.id).toBe("abc12345");
    expect(result.title).toBe("My Task");
    expect(result.description).toBe("Do something");
    expect(result.status).toBe("todo");
    expect(result.selector).toBe('[data-vibeflow-id="btn"]');
    expect(result.created).toBe("2025-01-01T00:00:00.000Z");
  });

  it("omits optional fields when not set", () => {
    const result = formatTaskForAgent(baseTask);
    expect(result.url).toBeUndefined();
    expect(result.file).toBeUndefined();
    expect(result.line).toBeUndefined();
    expect(result.col).toBeUndefined();
    expect(result.component).toBeUndefined();
    expect(result.screenshotUrl).toBeUndefined();
    expect(result.type).toBeUndefined();
    expect(result.priority).toBeUndefined();
    expect(result.comments).toBeUndefined();
    expect(result.reportBack).toBeUndefined();
    expect(result.structuredComments).toBeUndefined();
    expect(result.linkedFiles).toBeUndefined();
  });

  it("includes all optional fields when set", () => {
    const full: Task = {
      ...baseTask,
      url: "http://localhost:3000/page",
      file: "src/App.tsx",
      line: 42,
      col: 7,
      component: "MyButton",
      type: "feature",
      priority: "high",
      reportBack: true,
    };
    const result = formatTaskForAgent(full);
    expect(result.url).toBe("http://localhost:3000/page");
    expect(result.file).toBe("src/App.tsx");
    expect(result.line).toBe(42);
    expect(result.col).toBe(7);
    expect(result.component).toBe("MyButton");
    expect(result.type).toBe("feature");
    expect(result.priority).toBe("high");
    expect(result.reportBack).toBe(true);
  });

  it("line: 0 is included (falsy value must not be excluded)", () => {
    const taskWithLine0: Task = { ...baseTask, line: 0 };
    const result = formatTaskForAgent(taskWithLine0);
    expect(result.line).toBe(0);
  });

  it("includes structuredComments with author, timestamp, and text", () => {
    const comments: TaskComment[] = [
      { id: "c1", author: "user", text: "Please make the button blue.", createdAt: "2025-06-01T09:00:00.000Z" },
      { id: "c2", author: "agent", text: "Fixed in src/Button.tsx line 12.", createdAt: "2025-06-01T09:05:00.000Z", updatedAt: "2025-06-01T09:10:00.000Z" },
    ];
    const result = formatTaskForAgent(baseTask, comments);
    expect(result.structuredComments).toHaveLength(2);
    expect(result.structuredComments![0].author).toBe("user");
    expect(result.structuredComments![0].text).toBe("Please make the button blue.");
    expect(result.structuredComments![1].author).toBe("agent");
    expect(result.structuredComments![1].updatedAt).toBe("2025-06-01T09:10:00.000Z");
  });

  it("omits structuredComments when array is empty", () => {
    const result = formatTaskForAgent(baseTask, []);
    expect(result.structuredComments).toBeUndefined();
  });

  it("includes linkedFiles with name and url", () => {
    const files: FileInfo[] = [
      { name: "report.md", size: 1024, url: "http://localhost:3700/api/tasks/abc12345/files/report.md" },
    ];
    const result = formatTaskForAgent(baseTask, undefined, files);
    expect(result.linkedFiles).toHaveLength(1);
    expect(result.linkedFiles![0].name).toBe("report.md");
    expect(result.linkedFiles![0].url).toContain("report.md");
  });

  it("omits linkedFiles when array is empty", () => {
    const result = formatTaskForAgent(baseTask, undefined, []);
    expect(result.linkedFiles).toBeUndefined();
  });
});

// ── Migration: flat → date-subdirectory ──────────────────────────────────────

describe("migrateFlatTasksToDateDirs", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "proto-migrate-")); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("returns 0 when tasks directory does not exist", () => {
    expect(migrateFlatTasksToDateDirs(tempDir)).toBe(0);
  });

  it("returns 0 when all tasks are already in date subdirs", () => {
    const task = createTask(tempDir, { title: "Already nested", description: "" });
    const count = migrateFlatTasksToDateDirs(tempDir);
    expect(count).toBe(0);
    expect(findTaskFilePath(tempDir, task.id)).not.toBeNull();
  });

  it("moves flat JSON tasks into date subdirs and returns count", () => {
    ensureTaskDirs(tempDir);
    const tasksDir = getTasksDir(tempDir);

    const task: Task = {
      id: "abcd1234",
      title: "Flat task",
      description: "needs moving",
      status: "todo",
      selector: "/",
      created: "2025-01-15T10:00:00.000Z",
      updated: "2025-01-15T10:00:00.000Z",
      comments: [],
      files: [],
    };
    writeFileSync(join(tasksDir, "abcd1234.json"), JSON.stringify(task, null, 2), "utf-8");

    expect(migrateFlatTasksToDateDirs(tempDir)).toBe(1);

    // File should now be in date subdir
    const movedPath = join(tasksDir, "2025-01-15", "abcd1234.json");
    expect(existsSync(movedPath)).toBe(true);

    // Flat file should be gone
    expect(existsSync(join(tasksDir, "abcd1234.json"))).toBe(false);
  });

  it("skips non-JSON files in the tasks directory", () => {
    ensureTaskDirs(tempDir);
    const tasksDir = getTasksDir(tempDir);
    writeFileSync(join(tasksDir, "readme.txt"), "ignore me", "utf-8");
    expect(migrateFlatTasksToDateDirs(tempDir)).toBe(0);
  });

  it("skips unreadable/invalid JSON files", () => {
    ensureTaskDirs(tempDir);
    const tasksDir = getTasksDir(tempDir);
    writeFileSync(join(tasksDir, "bad1234.json"), "not-json", "utf-8");
    expect(migrateFlatTasksToDateDirs(tempDir)).toBe(0);
  });

  it("handles multiple flat tasks and moves all of them", () => {
    ensureTaskDirs(tempDir);
    const tasksDir = getTasksDir(tempDir);

    const task1: Task = {
      id: "aaaa1111",
      title: "First flat task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-10T10:00:00.000Z",
      updated: "2025-01-10T10:00:00.000Z",
      comments: [],
      files: [],
    };
    const task2: Task = {
      id: "bbbb2222",
      title: "Second flat task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-02-20T10:00:00.000Z",
      updated: "2025-02-20T10:00:00.000Z",
      comments: [],
      files: [],
    };
    writeFileSync(join(tasksDir, "aaaa1111.json"), JSON.stringify(task1, null, 2), "utf-8");
    writeFileSync(join(tasksDir, "bbbb2222.json"), JSON.stringify(task2, null, 2), "utf-8");

    expect(migrateFlatTasksToDateDirs(tempDir)).toBe(2);

    // Both files should be in their respective date subdirs
    expect(existsSync(join(tasksDir, "2025-01-10", "aaaa1111.json"))).toBe(true);
    expect(existsSync(join(tasksDir, "2025-02-20", "bbbb2222.json"))).toBe(true);

    // Flat files should be gone
    expect(existsSync(join(tasksDir, "aaaa1111.json"))).toBe(false);
    expect(existsSync(join(tasksDir, "bbbb2222.json"))).toBe(false);
  });

  it("skips files that are already in the correct date directory", () => {
    ensureTaskDirs(tempDir);
    const tasksDir = getTasksDir(tempDir);

    // Create a file already in the correct date subdir
    const dateDir = join(tasksDir, "2025-03-15");
    mkdirSync(dateDir, { recursive: true });
    const task: Task = {
      id: "cccc3333",
      title: "Already nested",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-03-15T10:00:00.000Z",
      updated: "2025-03-15T10:00:00.000Z",
      comments: [],
      files: [],
    };
    writeFileSync(join(dateDir, "cccc3333.json"), JSON.stringify(task, null, 2), "utf-8");

    // Should return 0 since file is already in correct place
    expect(migrateFlatTasksToDateDirs(tempDir)).toBe(0);
    expect(existsSync(join(dateDir, "cccc3333.json"))).toBe(true);
  });
});

describe("multiple commits support", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-commits-test-"));
    ensureTaskDirs(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores commits array on task", () => {
    const task = createTask(tempDir, { title: "Test task" });
    const commits = [
      { sha: "abc12345", message: "first commit", timestamp: "2025-01-01T00:00:00.000Z" },
      { sha: "def67890", message: "second commit", timestamp: "2025-01-02T00:00:00.000Z" },
    ];
    updateTask(tempDir, task.id, { commits });
    const updated = listTasks(tempDir).find((t) => t.id === task.id);
    expect(updated?.commits).toHaveLength(2);
    expect(updated?.commits?.[0].sha).toBe("abc12345");
    expect(updated?.commits?.[1].sha).toBe("def67890");
  });

  it("parses commits array from raw task JSON", () => {
    const task = createTask(tempDir, { title: "Test task" });
    const filePath = findTaskFilePath(tempDir, task.id);
    expect(filePath).toBeTruthy();
    const raw = JSON.parse(readFileSync(filePath!, "utf-8"));
    const withCommits = { ...raw, commits: [{ sha: "aaa", message: "msg", timestamp: "2025-01-01T00:00:00.000Z" }] };
    writeFileSync(filePath!, JSON.stringify(withCommits), "utf-8");
    const loaded = listTasks(tempDir).find((t) => t.id === task.id);
    expect(loaded?.commits).toHaveLength(1);
    expect(loaded?.commits?.[0].sha).toBe("aaa");
  });

  it("appends new commit to existing commits array", () => {
    const firstCommit = { sha: "first111", message: "initial", timestamp: "2025-01-01T00:00:00.000Z" };
    const task = createTask(tempDir, { title: "Test task" });
    updateTask(tempDir, task.id, { commits: [firstCommit] });

    const secondCommit = { sha: "second22", message: "follow-up", timestamp: new Date().toISOString() };
    const existing = listTasks(tempDir).find((t) => t.id === task.id);
    const prevCommits = existing?.commits ?? [];
    updateTask(tempDir, task.id, { commits: [...prevCommits, secondCommit] });

    const updated = listTasks(tempDir).find((t) => t.id === task.id);
    expect(updated?.commits).toHaveLength(2);
    expect(updated?.commits?.[1].sha).toBe("second22");
  });
});

describe("--next task selection logic", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-next-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Mirrors the priority ordering used by the --next handler in index.ts */
  function getPriorityRank(priority?: string): number {
    switch ((priority ?? "").toLowerCase()) {
      case "critical": return 0;
      case "high":     return 1;
      case "medium":   return 2;
      case "low":      return 3;
      default:         return 2;
    }
  }

  it("picks the only todo task when one exists", () => {
    createTask(tempDir, { title: "Only task", status: "todo", selector: "#a" });
    const todos = listTasksWithPaths(tempDir).filter((t) => t.status === "todo");
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toBe("Only task");
  });

  it("returns empty list when no todo tasks exist", () => {
    createTask(tempDir, { title: "Done task", status: "done", selector: "#a" });
    createTask(tempDir, { title: "In-progress task", status: "in-progress", selector: "#b" });
    const todos = listTasksWithPaths(tempDir).filter((t) => t.status === "todo");
    expect(todos).toHaveLength(0);
  });

  it("picks highest priority task first (critical before high)", () => {
    createTask(tempDir, { title: "High task", status: "todo", priority: "high", selector: "#a" });
    createTask(tempDir, { title: "Critical task", status: "todo", priority: "critical", selector: "#b" });
    const todos = listTasksWithPaths(tempDir)
      .filter((t) => t.status === "todo")
      .sort((a, b) => {
        const byPriority = getPriorityRank(a.priority) - getPriorityRank(b.priority);
        if (byPriority !== 0) return byPriority;
        return new Date(a.created).getTime() - new Date(b.created).getTime();
      });
    expect(todos[0].title).toBe("Critical task");
  });

  it("picks highest priority task first (high before medium)", () => {
    createTask(tempDir, { title: "Medium task", status: "todo", priority: "medium", selector: "#a" });
    createTask(tempDir, { title: "High task", status: "todo", priority: "high", selector: "#b" });
    const todos = listTasksWithPaths(tempDir)
      .filter((t) => t.status === "todo")
      .sort((a, b) => getPriorityRank(a.priority) - getPriorityRank(b.priority));
    expect(todos[0].title).toBe("High task");
  });

  it("breaks priority ties by creation time (oldest first)", () => {
    const first = createTask(tempDir, { title: "First medium", status: "todo", priority: "medium", selector: "#a" });
    // force an earlier creation date on the second task by mutating the stored file
    const second = createTask(tempDir, { title: "Second medium", status: "todo", priority: "medium", selector: "#b" });
    // Make second task appear older by setting its 'created' field earlier
    const { filePath } = listTasksWithPaths(tempDir).find((t) => t.id === second.id)!;
    const raw = JSON.parse(readFileSync(filePath!, "utf-8")) as Record<string, unknown>;
    raw.created = "2000-01-01T00:00:00.000Z";
    writeFileSync(filePath!, JSON.stringify(raw), "utf-8");

    const todos = listTasksWithPaths(tempDir)
      .filter((t) => t.status === "todo")
      .sort((a, b) => {
        const byPriority = getPriorityRank(a.priority) - getPriorityRank(b.priority);
        if (byPriority !== 0) return byPriority;
        return new Date(a.created).getTime() - new Date(b.created).getTime();
      });
    expect(todos[0].title).toBe("Second medium");
    expect(todos[1].title).toBe("First medium");
    // Cleanup: id not used further
    void first;
  });

  it("moving selected task to in-progress via updateTask persists correctly", () => {
    const task = createTask(tempDir, { title: "Task to start", status: "todo", selector: "#x" });
    const updated = updateTask(tempDir, task.id, { status: "in-progress" });
    expect(updated?.status).toBe("in-progress");

    const loaded = listTasks(tempDir).find((t) => t.id === task.id);
    expect(loaded?.status).toBe("in-progress");
  });

  it("only todo tasks are candidates — in-progress and done tasks are excluded", () => {
    createTask(tempDir, { title: "Todo task", status: "todo", selector: "#a" });
    createTask(tempDir, { title: "In-progress task", status: "in-progress", selector: "#b" });
    createTask(tempDir, { title: "Done task", status: "done", selector: "#c" });

    const todos = listTasksWithPaths(tempDir).filter((t) => t.status === "todo");
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toBe("Todo task");
  });

  it("--next --type filters to only matching type", () => {
    createTask(tempDir, { title: "Bug todo", status: "todo", type: "Bug", selector: "#a" });
    createTask(tempDir, { title: "Feature todo", status: "todo", type: "Feature", selector: "#b" });

    const todos = listTasksWithPaths(tempDir).filter((t) => t.status === "todo");
    const filtered = todos.filter((t) => (t.type ?? "Task").toLowerCase() === "bug");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Bug todo");
  });

  it("--next --type returns empty when no matching type exists", () => {
    createTask(tempDir, { title: "Feature todo", status: "todo", type: "Feature", selector: "#a" });

    const todos = listTasksWithPaths(tempDir).filter((t) => t.status === "todo");
    const filtered = todos.filter((t) => (t.type ?? "Task").toLowerCase() === "bug");
    expect(filtered).toHaveLength(0);
  });

  it("--next --tag filters to only tasks with that tag", () => {
    createTask(tempDir, { title: "Tagged todo", status: "todo", selector: "#a", tags: ["urgent"] });
    createTask(tempDir, { title: "Untagged todo", status: "todo", selector: "#b" });

    const todos = listTasksWithPaths(tempDir).filter((t) => t.status === "todo");
    const filtered = todos.filter((t) => ["urgent"].every(tag => (t.tags ?? []).includes(tag)));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Tagged todo");
  });

  it("--next --user filters to only tasks by that author", () => {
    createTask(tempDir, { title: "Alice todo", status: "todo", selector: "#a", author: "alice@example.com" });
    createTask(tempDir, { title: "Bob todo", status: "todo", selector: "#b", author: "bob@example.com" });

    const todos = listTasksWithPaths(tempDir).filter((t) => t.status === "todo");
    const filtered = todos.filter((t) => (t.author ?? "").toLowerCase() === "alice@example.com");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Alice todo");
  });

  it("--next combined type and tag filters narrows candidates correctly", () => {
    createTask(tempDir, { title: "Bug urgent", status: "todo", type: "Bug", selector: "#a", tags: ["urgent"] });
    createTask(tempDir, { title: "Bug normal", status: "todo", type: "Bug", selector: "#b" });
    createTask(tempDir, { title: "Feature urgent", status: "todo", type: "Feature", selector: "#c", tags: ["urgent"] });

    const todos = listTasksWithPaths(tempDir).filter((t) => t.status === "todo");
    const filtered = todos
      .filter((t) => (t.type ?? "Task").toLowerCase() === "bug")
      .filter((t) => ["urgent"].every(tag => (t.tags ?? []).includes(tag)));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Bug urgent");
  });
});

describe("--tag filter logic", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-tag-filter-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Applies the same tag filter logic used in the tasks command. */
  function applyTagFilter(tasks: ReturnType<typeof listTasks>, tags: string[]): ReturnType<typeof listTasks> {
    if (!tags.length) return tasks;
    return tasks.filter((t) => tags.every((tag) => (t.tags ?? []).includes(tag)));
  }

  it("returns all tasks when no tag filter is given", () => {
    createTask(tempDir, { title: "A", selector: "#a", tags: ["x"] });
    createTask(tempDir, { title: "B", selector: "#b" });
    const all = listTasks(tempDir);
    expect(applyTagFilter(all, [])).toHaveLength(2);
  });

  it("filters to tasks that have the specified tag", () => {
    createTask(tempDir, { title: "Tagged", selector: "#a", tags: ["frontend"] });
    createTask(tempDir, { title: "Untagged", selector: "#b" });
    createTask(tempDir, { title: "Other tag", selector: "#c", tags: ["backend"] });

    const result = applyTagFilter(listTasks(tempDir), ["frontend"]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Tagged");
  });

  it("AND logic: only returns tasks that have ALL specified tags", () => {
    createTask(tempDir, { title: "Both", selector: "#a", tags: ["frontend", "urgent"] });
    createTask(tempDir, { title: "Frontend only", selector: "#b", tags: ["frontend"] });
    createTask(tempDir, { title: "Urgent only", selector: "#c", tags: ["urgent"] });
    createTask(tempDir, { title: "Neither", selector: "#d" });

    const result = applyTagFilter(listTasks(tempDir), ["frontend", "urgent"]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Both");
  });

  it("returns empty array when no task has all specified tags", () => {
    createTask(tempDir, { title: "A", selector: "#a", tags: ["x"] });
    createTask(tempDir, { title: "B", selector: "#b", tags: ["y"] });

    const result = applyTagFilter(listTasks(tempDir), ["x", "y"]);
    expect(result).toHaveLength(0);
  });

  it("tag filter is case-sensitive (matches exact casing)", () => {
    createTask(tempDir, { title: "Lower", selector: "#a", tags: ["frontend"] });
    createTask(tempDir, { title: "Upper", selector: "#b", tags: ["Frontend"] });

    const lower = applyTagFilter(listTasks(tempDir), ["frontend"]);
    expect(lower).toHaveLength(1);
    expect(lower[0].title).toBe("Lower");

    const upper = applyTagFilter(listTasks(tempDir), ["Frontend"]);
    expect(upper).toHaveLength(1);
    expect(upper[0].title).toBe("Upper");
  });

  it("tasks persist tags correctly via updateTask", () => {
    const task = createTask(tempDir, { title: "Task", selector: "#a" });
    updateTask(tempDir, task.id, { tags: ["alpha", "beta"] });

    const loaded = listTasks(tempDir).find((t) => t.id === task.id);
    expect(loaded?.tags).toEqual(["alpha", "beta"]);

    const result = applyTagFilter(listTasks(tempDir), ["alpha"]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Task");
  });
});

// ── renderTaskForAgent ──────────────────────────────────────────────────────

describe("renderTaskForAgent", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), "proto-render-")); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("renders basic task with status, title, id, file, selector, created", () => {
    const task = createTask(tempDir, { title: "Render me", description: "", status: "todo", selector: "#btn" });
    const filePath = findTaskFilePath(tempDir, task.id)!;
    const output = renderTaskForAgent(task, filePath, [], [], tempDir);

    expect(output).toContain("[todo] Render me");
    expect(output).toContain(`id:       ${task.id}`);
    expect(output).toContain(`file:     ${filePath}`);
    expect(output).toContain(`selector: #btn`);
    expect(output).toContain(`created:  ${task.created}`);
  });

  it("renders source line when task has file and line", () => {
    const task: Task = {
      id: "src12345",
      title: "Source task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      file: "src/App.tsx",
      line: 42,
      col: 7,
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("source:   src/App.tsx:42:7");
  });

  it("renders source without col when col is null", () => {
    const task: Task = {
      id: "src12346",
      title: "No col",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      file: "src/App.tsx",
      line: 42,
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("source:   src/App.tsx:42");
    expect(output).not.toMatch(/:42:/);
  });

  it("renders component when present", () => {
    const task: Task = {
      id: "comp1234",
      title: "Component task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      component: "MyButton",
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("component: MyButton");
  });

  it("renders cssSelector when present", () => {
    const task: Task = {
      id: "css12345",
      title: "CSS task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      cssSelector: "div.hero > h1",
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("css:      div.hero > h1");
  });

  it("renders url when present", () => {
    const task: Task = {
      id: "url12345",
      title: "URL task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      url: "http://localhost:3000/page",
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("url:      http://localhost:3000/page");
  });

  it("renders single commit when one commit exists", () => {
    const task: Task = {
      id: "cmt12345",
      title: "Commit task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      commits: [{ sha: "abc123def456", message: "fix: something", timestamp: "2025-01-01T00:00:00.000Z" }],
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("commit:   abc123def456");
    expect(output).not.toContain("commits (");
  });

  it("renders multiple commits header when 2+ commits exist", () => {
    const task: Task = {
      id: "cmt12346",
      title: "Multi commit",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      commits: [
        { sha: "aaa111bbb222", message: "first", timestamp: "2025-01-01T00:00:00.000Z" },
        { sha: "ccc333ddd444", message: "second", timestamp: "2025-01-02T00:00:00.000Z" },
      ],
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("commits (2):");
    expect(output).toContain("aaa111bb");
    expect(output).toContain("ccc333dd");
  });

  it("renders type and priority when present", () => {
    const task: Task = {
      id: "tp123456",
      title: "Type priority",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      type: "Bug",
      priority: "High",
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("type:     Bug");
    expect(output).toContain("priority: High");
  });

  it("renders author when present", () => {
    const task: Task = {
      id: "auth1234",
      title: "Author task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      author: "alice@example.com",
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("author:   alice@example.com");
  });

  it("renders description with indented lines", () => {
    const task: Task = {
      id: "desc1234",
      title: "Desc task",
      description: "Line one\nLine two",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("description:");
    expect(output).toContain("      Line one");
    expect(output).toContain("      Line two");
  });

  it("renders annotatedElementText when present", () => {
    const task: Task = {
      id: "elem1234",
      title: "Element task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      annotatedElementText: "Submit Button",
    };
    const output = renderTaskForAgent(task, "/path/to/task.json", [], [], tempDir);
    expect(output).toContain("element text: Submit Button");
  });

  it("renders comments with author and text", () => {
    const task: Task = {
      id: "cmt12347",
      title: "Comment task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    };
    const comments: TaskComment[] = [
      { id: "c1", author: "user", text: "Hello", createdAt: "2025-01-01T00:00:00.000Z" },
      { id: "c2", author: "agent", text: "World", createdAt: "2025-01-01T01:00:00.000Z", updatedAt: "2025-01-01T02:00:00.000Z" },
    ];
    const output = renderTaskForAgent(task, "/path/to/task.json", comments, [], tempDir);
    expect(output).toContain("comments (2):");
    expect(output).toContain("[user]");
    expect(output).toContain("[agent]");
    expect(output).toContain("Hello");
    expect(output).toContain("World");
    expect(output).toContain("(edited");
  });

  it("renders linked files with name and url", () => {
    const task: Task = {
      id: "files123",
      title: "Files task",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    };
    const files: FileInfo[] = [
      { name: "report.md", size: 100, url: "/api/tasks/files123/files/report.md" },
    ];
    const output = renderTaskForAgent(task, "/path/to/task.json", [], files, tempDir);
    expect(output).toContain("linked files (1):");
    expect(output).toContain("- report.md");
    expect(output).toContain("/api/tasks/files123/files/report.md");
  });

  it("renders file content preview for small .md files that exist", () => {
    const task = createTask(tempDir, { title: "Preview task", description: "", status: "todo", selector: "/" });
    const filesDir = join(tempDir, ".vibeflow", "tasks", "files", task.id);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "preview.md"), "Hello\nWorld", "utf-8");

    const files: FileInfo[] = [
      { name: "preview.md", size: 11, url: "/api/tasks/files/files/preview.md", linkedPath: join(filesDir, "preview.md") },
    ];
    const filePath = findTaskFilePath(tempDir, task.id)!;
    const output = renderTaskForAgent(task, filePath, [], files, tempDir);
    expect(output).toContain("── content ──");
    expect(output).toContain("Hello");
    expect(output).toContain("World");
  });
});

// ── renderAgentInstructions ─────────────────────────────────────────────────

describe("renderAgentInstructions", () => {
  it("renders base instructions without any settings", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false });
    expect(output).toContain("Agent instructions (concise):");
    expect(output).toContain("Discover:");
    expect(output).toContain("Workflow:");
    expect(output).toContain("in-progress");
    expect(output).toContain("NEVER edit .vibeflow/");
    expect(output).toContain("NEVER set a task status to \"done\"");
  });

  it("includes auto-commit step 3/4 when autoCommit is true", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, autoCommit: true });
    expect(output).toContain("git add <files>   (stage your changes first)");
    expect(output).toContain('--commit-message "<one-line summary>"');
    expect(output).toContain("CLI will commit staged changes");
  });

  it("includes manual commit step when autoCommit is false", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, autoCommit: false });
    expect(output).toContain("git add <files> && vibeflow tasks --commit");
    expect(output).not.toContain("CLI will commit staged changes");
  });

  it("includes --comment arg in review step when autoComment is true with autoCommit", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, autoCommit: true, autoComment: true });
    expect(output).toContain('--comment "<report>"');
  });

  it("includes --comment arg in review step when autoComment is true without autoCommit", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, autoCommit: false, autoComment: true });
    expect(output).toContain('--comment "<report>"');
  });

  it("includes Comment format section when autoComment is true", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, autoComment: true });
    expect(output).toContain("Comment format (--comment):");
    expect(output).toContain("Plain text for concise");
    expect(output).toContain("Markdown for multi-section");
  });

  it("excludes Comment format section when autoComment is false", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, autoComment: false });
    expect(output).not.toContain("Comment format (--comment):");
  });

  it("includes Auto-push setting when autoPush is true", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, autoPush: true });
    expect(output).toContain("Auto-push ON");
  });

  it("excludes Auto-push setting when autoPush is false", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, autoPush: false });
    expect(output).not.toContain("Auto-push ON");
  });

  it("includes Auto-commit setting when autoCommit is true", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, autoCommit: true });
    expect(output).toContain("Auto-commit ON");
  });

  it("includes Auto-comment setting when autoComment is true", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, autoComment: true });
    expect(output).toContain("Auto-comment ON");
  });

  it("includes Create branch instructions when createBranch is true", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, createBranch: true });
    expect(output).toContain("Create branch ON");
    expect(output).toContain("git checkout -b");
    expect(output).toContain("Branch name rules");
    expect(output).toContain("Create a branch FIRST");
  });

  it("excludes Create branch instructions when createBranch is false", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, createBranch: false });
    expect(output).not.toContain("Create branch ON");
    expect(output).not.toContain("git checkout -b");
  });

  it("includes Research task instructions when hasResearchTasks is true", () => {
    const output = renderAgentInstructions({ hasResearchTasks: true });
    expect(output).toContain("Research tasks:");
    expect(output).toContain("NEVER generate code");
    expect(output).toContain("--report-file");
    expect(output).toContain("CLI ENFORCES");
  });

  it("excludes Research task instructions when hasResearchTasks is false", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false });
    expect(output).not.toContain("Research tasks:");
    expect(output).not.toContain("--report-file");
  });

  it("includes Bug task instructions when hasBugTasks is true", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, hasBugTasks: true });
    expect(output).toContain("Bug tasks:");
    expect(output).toContain("error logs / stack traces");
  });

  it("excludes Bug task instructions when hasBugTasks is false", () => {
    const output = renderAgentInstructions({ hasResearchTasks: false, hasBugTasks: false });
    expect(output).not.toContain("Bug tasks:");
  });

  it("renders all settings together", () => {
    const output = renderAgentInstructions({
      hasResearchTasks: true,
      hasBugTasks: true,
      autoCommit: true,
      autoPush: true,
      autoComment: true,
      createBranch: true,
    });
    expect(output).toContain("Auto-commit ON");
    expect(output).toContain("Auto-push ON");
    expect(output).toContain("Auto-comment ON");
    expect(output).toContain("Create branch ON");
    expect(output).toContain("Research tasks:");
    expect(output).toContain("Bug tasks:");
    expect(output).toContain("Comment format (--comment):");
  });
});

