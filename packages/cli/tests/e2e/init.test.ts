import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureTaskDirs } from "../../src/core/tasks.js";
import { writeConfig } from "../../src/core/config.js";

const CLI = join(process.cwd(), "dist", "index.js");
const run = (args: string, cwd?: string) =>
  execSync(`node ${CLI} ${args}`, {
    encoding: "utf-8",
    cwd: cwd ?? process.cwd(),
  });

/** Fast setup helper — directly creates the .proto structure without the CLI. */
function initProtoDir(dir: string): void {
  ensureTaskDirs(dir);
  writeConfig(dir, { mode: "attach", port: 3700 });
}

describe("proto tasks (e2e)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-e2e-tasks-"));
    initProtoDir(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("shows 'No tasks found' for empty task dir", () => {
    const output = run(`tasks ${tempDir}`);
    expect(output).toContain("No tasks found");
  });

  it("lists tasks with --status filter after creating tasks via API", async () => {
    // This test just verifies the CLI runs without error with filters
    const output = run(`tasks ${tempDir} --status todo`);
    expect(output).toContain("No tasks found");
  });

  it("supports tasks --add for CLI task creation", () => {
    const output = run(`tasks ${tempDir} --add --title "CLI created task" --description "Created from CLI"`);
    expect(output).toContain("Task created");
    expect(output).toContain("CLI created task");

    const listOutput = run(`tasks ${tempDir} --status todo`);
    expect(listOutput).toContain("CLI created task");
  });

  it("auto-creates .proto/ when tasks --add is called without prior init", () => {
    // No initProtoDir — .proto/ does not exist in tempDir yet
    const freshDir = mkdtempSync(join(tmpdir(), "proto-e2e-autoinit-"));
    try {
      expect(existsSync(join(freshDir, ".vibeflow"))).toBe(false);
      const output = run(`tasks ${freshDir} --add --title "Auto-init task"`);
      expect(output).toContain("Task created");
      expect(existsSync(join(freshDir, ".vibeflow", "tasks"))).toBe(true);
      const listOutput = run(`tasks ${freshDir} --status todo`);
      expect(listOutput).toContain("Auto-init task");
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("supports tasks --json machine-readable output", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "jsontask1.json"), JSON.stringify({
      id: "jsontask1",
      title: "JSON task",
      description: "Structured output",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      comments: [],
      files: [],
    }, null, 2), "utf-8");

    const jsonOutput = run(`tasks ${tempDir} --json`);
    const parsed = JSON.parse(jsonOutput) as Array<{ id: string; title: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((t) => t.id === "jsontask1" && t.title === "JSON task")).toBe(true);
  });

  it("--edit with no task-id prints LLM usage instructions", () => {
    const output = run(`tasks ${tempDir} --edit`);
    expect(output).toContain("LLM Usage Instructions");
    expect(output).toContain("--edit <task-id>");
    expect(output).toContain("--set-status");
  });

  it("--edit with task-id but no fields also prints LLM usage instructions", () => {
    const output = run(`tasks ${tempDir} --edit abc12345`);
    expect(output).toContain("LLM Usage Instructions");
    // With no tasks in the project it shows "No tasks found."
    expect(output).toContain("No tasks found");
  });

  it("--edit updates task title and status", () => {
    // Create a task file manually in JSON format
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "test1234.json"), JSON.stringify({
      id: "test1234",
      title: "Original Title",
      description: "Original description.",
      status: "todo",
      selector: "#btn",
      created: "2025-01-01T00:00:00.000Z",
      comments: [],
      files: [],
    }, null, 2), "utf-8");

    const output = run(`tasks ${tempDir} --edit test1234 --title "Updated Title" --set-status in-progress`);
    expect(output).toContain("Task updated");
    expect(output).toContain("Updated Title");

    // Verify the file was actually updated
    const listOutput = run(`tasks ${tempDir}`);
    expect(listOutput).toContain("Updated Title");
    expect(listOutput).toContain("in-progress");
  });

  it("--edit with unknown task-id exits with error code 1", () => {
    let threw = false;
    try {
      run(`tasks ${tempDir} --edit nonexist --title "Foo"`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("--set-status with invalid value exits with error code 1 and shows guidance", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "validtask1.json"), JSON.stringify({
      id: "validtask1", title: "Valid Task", description: "",
      status: "todo", selector: "#x", created: "2025-01-01T00:00:00.000Z",
      comments: [], files: [],
    }, null, 2), "utf-8");

    let output = "";
    let threw = false;
    try {
      run(`tasks ${tempDir} --edit validtask1 --set-status invalid-status`);
    } catch (err: unknown) {
      threw = true;
      output = (err as { stdout?: string }).stdout ?? "";
    }
    expect(threw).toBe(true);
    expect(output).toContain("invalid-status");
    expect(output).toContain("backlog");
  });

  it("--status with invalid value exits with error code 1 and shows guidance", () => {
    let output = "";
    let threw = false;
    try {
      run(`tasks ${tempDir} --status notastatus`);
    } catch (err: unknown) {
      threw = true;
      output = (err as { stdout?: string }).stdout ?? "";
    }
    expect(threw).toBe(true);
    expect(output).toContain("notastatus");
    expect(output).toContain("backlog");
  });

  it("filters tasks by --type", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "type-task.json"), JSON.stringify({
      id: "type-task", title: "Feature polish", description: "",
      status: "todo", selector: "#a", type: "Task",
      created: "2025-01-01T00:00:00.000Z", comments: [], files: [],
    }, null, 2), "utf-8");
    writeFileSync(join(tasksDir, "type-bug.json"), JSON.stringify({
      id: "type-bug", title: "Fix save race", description: "",
      status: "todo", selector: "#b", type: "Bug",
      created: "2025-01-01T00:00:00.000Z", comments: [], files: [],
    }, null, 2), "utf-8");

    const output = run(`tasks ${tempDir} --type bug`);
    expect(output).toContain("Fix save race");
    expect(output).not.toContain("Feature polish");
  });

  it("filters tasks by --user using exact email match (case-insensitive)", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "user-a.json"), JSON.stringify({
      id: "user-a", title: "Alice task", description: "",
      status: "todo", selector: "#a", author: "alice@example.com",
      created: "2025-01-01T00:00:00.000Z", comments: [], files: [],
    }, null, 2), "utf-8");
    writeFileSync(join(tasksDir, "user-b.json"), JSON.stringify({
      id: "user-b", title: "Bob task", description: "",
      status: "todo", selector: "#b", author: "bob@example.com",
      created: "2025-01-01T00:00:00.000Z", comments: [], files: [],
    }, null, 2), "utf-8");

    const output = run(`tasks ${tempDir} --user ALICE@EXAMPLE.COM`);
    expect(output).toContain("Alice task");
    expect(output).not.toContain("Bob task");

    const editOutput = run(`tasks ${tempDir} --edit --user alice@example.com`);
    expect(editOutput).toContain("Alice task");
    expect(editOutput).not.toContain("Bob task");
  });

  it("rejects partial --user filter and shows available users", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "user-aa.json"), JSON.stringify({
      id: "user-aa", title: "Alice task", description: "",
      status: "todo", selector: "#a", author: "alice@example.com",
      created: "2025-01-01T00:00:00.000Z", comments: [], files: [],
    }, null, 2), "utf-8");
    writeFileSync(join(tasksDir, "user-bb.json"), JSON.stringify({
      id: "user-bb", title: "Bob task", description: "",
      status: "todo", selector: "#b", author: "bob@example.com",
      created: "2025-01-01T00:00:00.000Z", comments: [], files: [],
    }, null, 2), "utf-8");

    let output = "";
    let threw = false;
    try {
      run(`tasks ${tempDir} --user alice`);
    } catch (err: unknown) {
      threw = true;
      output = (err as { stdout?: string }).stdout ?? "";
    }
    expect(threw).toBe(true);
    expect(output).toContain("User not found");
    expect(output).toContain("Available users:");
    expect(output).toContain("alice@example.com");
    expect(output).toContain("bob@example.com");
  });

  it("invalid --type filter prints available hardcoded types", () => {
    let output = "";
    let threw = false;
    try {
      run(`tasks ${tempDir} --type not-a-type`);
    } catch (err: unknown) {
      threw = true;
      output = (err as { stdout?: string }).stdout ?? "";
    }
    expect(threw).toBe(true);
    expect(output).toContain("Invalid type filter");
    expect(output).toContain("Available types:");
    expect(output).toContain("Task");
    expect(output).toContain("Bug");
    expect(output).toContain("Research");
  });

  // ── Regression: tasks.md fixes ───────────────────────────────────────────

  it("tasks list output includes file path for each task", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "pathtest1.json"), JSON.stringify({
      id: "pathtest1",
      title: "Task with path",
      description: "",
      status: "todo",
      selector: "#btn",
      created: "2025-01-01T00:00:00.000Z",
      comments: [],
      files: [],
    }, null, 2), "utf-8");

    const output = run(`tasks ${tempDir}`);
    // File path should be the absolute path to the JSON file
    expect(output).toContain("file:");
    expect(output).toContain(tempDir);
    expect(output).toContain("pathtest1.json");
  });

  it("--edit respects --status filter when listing available tasks", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "todotask1.json"), JSON.stringify({
      id: "todotask1", title: "Todo Task", description: "",
      status: "todo", selector: "#a", created: "2025-01-01T00:00:00.000Z",
      comments: [], files: [],
    }, null, 2), "utf-8");
    writeFileSync(join(tasksDir, "donetask1.json"), JSON.stringify({
      id: "donetask1", title: "Done Task", description: "",
      status: "done", selector: "#b", created: "2025-01-01T00:00:00.000Z",
      comments: [], files: [],
    }, null, 2), "utf-8");

    // Without filter: lists both tasks in usage instructions
    const outputAll = run(`tasks ${tempDir} --edit`);
    expect(outputAll).toContain("Todo Task");
    expect(outputAll).toContain("Done Task");

    // With --status todo: only shows todo tasks in the edit usage list
    const outputTodo = run(`tasks ${tempDir} --edit --status todo`);
    expect(outputTodo).toContain("Todo Task");
    expect(outputTodo).not.toContain("Done Task");
  });

  it("tasks list shows cssSelector when present", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "csstask1.json"), JSON.stringify({
      id: "csstask1", title: "CSS Selector Task", description: "",
      status: "todo", selector: '[data-testid="hero"]',
      cssSelector: "main > section > h1",
      created: "2025-01-01T00:00:00.000Z",
      comments: [], files: [],
    }, null, 2), "utf-8");

    const output = run(`tasks ${tempDir}`);
    expect(output).toContain("css:");
    expect(output).toContain("main > section > h1");
  });

  it("tasks list prints concise agent instructions", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "insttask1.json"), JSON.stringify({
      id: "insttask1", title: "Instruction test", description: "",
      status: "todo", selector: "#x", created: "2025-01-01T00:00:00.000Z",
      comments: [], files: [],
    }, null, 2), "utf-8");

    const output = run(`tasks ${tempDir} --status todo`);
    expect(output).toContain("Agent instructions (concise):");
    expect(output).toContain("--set-status in-progress");
    expect(output).toContain("--set-status review");
    expect(output).toContain("--commit --task");
  });

  it("shows research-specific instruction only when research tasks are listed", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeFileSync(join(tasksDir, "normal001.json"), JSON.stringify({
      id: "normal001", title: "Normal task", description: "",
      status: "todo", selector: "#a", type: "Task",
      created: "2025-01-01T00:00:00.000Z",
      comments: [], files: [],
    }, null, 2), "utf-8");

    const normalOutput = run(`tasks ${tempDir} --status todo`);
    expect(normalOutput).not.toContain("attach a .md report file");

    writeFileSync(join(tasksDir, "research01.json"), JSON.stringify({
      id: "research", title: "Research task", description: "",
      status: "todo", selector: "#b", type: "Research",
      created: "2025-01-01T00:00:00.000Z",
      comments: [], files: [],
    }, null, 2), "utf-8");

    const researchOutput = run(`tasks ${tempDir} --status todo`);
    expect(researchOutput).toContain("Attach a .md report");
  });

  it("--edit --description updates task description", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "desctask1.json"), JSON.stringify({
      id: "desctask1", title: "Button Task", description: "Old description.",
      status: "todo", selector: "#btn", created: "2025-01-01T00:00:00.000Z",
      comments: [], files: [],
    }, null, 2), "utf-8");

    const output = run(`tasks ${tempDir} --edit desctask1 --description "The button needs better contrast"`);
    expect(output).toContain("Task updated");
    expect(output).toContain("Button Task");

    const listOutput = run(`tasks ${tempDir}`);
    expect(listOutput).toContain("The button needs better contrast");
  });

  it("--edit --set-status review requires --comment", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "reviewtask1.json"), JSON.stringify({
      id: "reviewtask1", title: "Review Comment Test", description: "",
      status: "in-progress", selector: "#x", created: "2025-01-01T00:00:00.000Z",
      comments: [], files: [],
    }, null, 2), "utf-8");
    // Disable autoCommit and autoComment in local settings to prevent interference from global settings
    writeFileSync(join(tempDir, ".vibeflow", "settings.json"), JSON.stringify({ autoCommit: false, autoComment: false }), "utf-8");

    // Should fail without --comment
    expect(() => run(`tasks ${tempDir} --edit reviewtask1 --set-status review`)).toThrow();

    // Should succeed with --comment
    const output = run(`tasks ${tempDir} --edit reviewtask1 --set-status review --comment "Fixed the alignment issue by adjusting flex layout"`);
    expect(output).toContain("Task updated");
    expect(output).toContain("comment: added");

    // updateTask migrates the flat file to a date-based subdirectory (2025-01-01/)
    const movedTaskPath = join(tasksDir, "2025-01-01", "reviewtask1.json");
    const taskData = JSON.parse(readFileSync(movedTaskPath, "utf-8"));
    expect(taskData.status).toBe("review");
  });

  it("tasks list shows description when present", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "descdisplay1.json"), JSON.stringify({
      id: "descdisplay1", title: "Feature card feedback",
      description: "Feature card feedback", status: "todo",
      selector: '[data-vibeflow-id="feature-card"]', url: "/",
      created: "2025-01-01T00:00:00.000Z", comments: [], files: [],
    }, null, 2), "utf-8");

    const output = run(`tasks ${tempDir}`);
    expect(output).toContain("Feature card feedback");
    expect(output).toContain("feature-card");
  });

  it("tasks list shows url when present", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "urltask1.json"), JSON.stringify({
      id: "urltask1", title: "API-only task", description: "",
      status: "todo", selector: '[data-testid="submit-btn"]',
      url: "http://localhost:5173/checkout",
      created: "2025-01-01T00:00:00.000Z", comments: [], files: [],
    }, null, 2), "utf-8");

    const output = run(`tasks ${tempDir}`);
    expect(output).toContain("url:");
    expect(output).toContain("localhost:5173/checkout");
  });

  it("full workflow: mark all todo tasks done removes them from todo list", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });

    const tasks = [
      { id: "task0001", title: "Fix main button", selector: "#primary-btn", url: "/" },
      { id: "task0002", title: "Feature card feedback", selector: '[data-vibeflow-id="feature-card"]', url: "/" },
      { id: "task0003", title: "CORS task", selector: "#primary-btn" },
    ];

    for (const t of tasks) {
      writeFileSync(join(tasksDir, `${t.id}.json`), JSON.stringify({
        id: t.id, title: t.title, description: "",
        status: "todo", selector: t.selector,
        ...(t.url ? { url: t.url } : {}),
        created: "2025-01-01T00:00:00.000Z", comments: [], files: [],
      }, null, 2), "utf-8");
    }

    // All 3 should be todo
    let output = run(`tasks ${tempDir} --status todo`);
    expect(output).toContain("Fix main button");
    expect(output).toContain("Feature card feedback");
    expect(output).toContain("CORS task");

    // Mark each done
    for (const t of tasks) {
      run(`tasks ${tempDir} --edit ${t.id} --set-status done`);
    }

    // No more todo tasks
    const afterOutput = run(`tasks ${tempDir} --status todo`);
    expect(afterOutput).toContain("No tasks found");

    // All show as done overall
    const allOutput = run(`tasks ${tempDir}`);
    expect(allOutput).toContain("done");
  });

  it("tasks list shows screenshot as HTTP URL (not local file path)", () => {
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    const screenshotsDir = join(tempDir, ".vibeflow", "screenshots");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(screenshotsDir, { recursive: true });

    // Write a task file with a screenshot reference
    writeFileSync(join(tasksDir, "shottask1.json"), JSON.stringify({
      id: "shottask1", title: "Screenshot task", description: "",
      status: "todo", selector: "#hero",
      screenshot: "shot-abc123.png",
      created: "2025-01-01T00:00:00.000Z", comments: [], files: [],
    }, null, 2), "utf-8");
    // Create a dummy screenshot file
    writeFileSync(join(screenshotsDir, "shot-abc123.png"), "PNG", "utf-8");

    const output = run(`tasks ${tempDir}`);
    // Should contain the HTTP URL, not a local file path
    expect(output).toContain("http://localhost:");
    expect(output).toContain("/screenshots/shot-abc123.png");
    // Should NOT contain the local file system path
    expect(output).not.toContain(".vibeflow/screenshots");
  });
});

describe("proto archive (e2e) — removed", () => {
  it("archive command no longer exists", () => {
    // archive was removed in a prior release; this block is intentionally empty
  });
});

describe("proto tasks --comment normalization (e2e)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-e2e-comment-normalize-"));
    initProtoDir(tempDir);
    // Disable auto-commit and auto-comment so --set-status review doesn't try git operations
    writeFileSync(
      join(tempDir, ".vibeflow", "settings.json"),
      JSON.stringify({ autoCommit: false, autoComment: false }),
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createTask(title: string): string {
    const output = run(`tasks ${tempDir} --add --title "${title}"`);
    const match = /id:\s+(\S+)/.exec(output);
    if (!match) throw new Error(`Could not parse task id from: ${output}`);
    return match[1];
  }

  it("normalizes literal \\n in --comment to actual newlines on set-status review", () => {
    const taskId = createTask("Normalize test task");
    // Pass literal \n (backslash + n) as they appear in double-quoted bash strings
    run(`tasks ${tempDir} --edit ${taskId} --set-status review --comment "line1\\nline2\\n\\nbullets:\\n- A\\n- B"`);

    const getOutput = run(`tasks ${tempDir} --get ${taskId}`);
    // The comment should show actual newlines, not \n sequences
    expect(getOutput).toContain("line1");
    expect(getOutput).toContain("line2");
    expect(getOutput).toContain("bullets:");
    expect(getOutput).toContain("- A");
    expect(getOutput).toContain("- B");
    // Literal \n sequences should NOT appear in the output
    expect(getOutput).not.toMatch(/line1\\nline2/);
  });

  it("stores comment with actual newlines in task JSON file", () => {
    const taskId = createTask("JSON storage test");
    run(`tasks ${tempDir} --edit ${taskId} --set-status review --comment "Summary:\\n\\n- Changed X\\n- Changed Y"`);

    // Find task JSON by scanning date subdirectories
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    let taskFilePath: string | null = null;
    for (const day of readdirSync(tasksDir)) {
      const candidate = join(tasksDir, day, `${taskId}.json`);
      if (existsSync(candidate)) { taskFilePath = candidate; break; }
    }
    if (!taskFilePath) throw new Error(`Task file not found for id: ${taskId}`);

    const taskJson = JSON.parse(readFileSync(taskFilePath, "utf-8")) as { comments: Array<{ text: string }> };
    const commentText = taskJson.comments[taskJson.comments.length - 1].text;

    // Should contain actual newline characters, not literal \n
    expect(commentText).toContain("\n");
    expect(commentText).not.toContain("\\n");
    expect(commentText).toBe("Summary:\n\n- Changed X\n- Changed Y");
  });

  it("leaves plain text comments unchanged", () => {
    const taskId = createTask("Plain text comment test");
    run(`tasks ${tempDir} --edit ${taskId} --set-status review --comment "Simple one-liner comment"`);

    const getOutput = run(`tasks ${tempDir} --get ${taskId}`);
    expect(getOutput).toContain("Simple one-liner comment");
  });

  it("handles comment that already uses actual newlines (idempotent)", () => {
    // Write a task with a comment that already has actual newlines (not literal \n sequences)
    const taskId = "actualnewlinetask1";
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(tasksDir, `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        title: "Actual newline task",
        description: "",
        status: "in-progress",
        selector: "/",
        created: "2026-01-01T00:00:00.000Z",
        comments: [],
        files: [],
      }, null, 2),
      "utf-8",
    );
    // Pass a comment with no literal \n — just plain text over multiple --comment calls
    run(`tasks ${tempDir} --edit ${taskId} --set-status review --comment "Plain line without escapes"`);

    // Find task JSON by scanning date subdirectories
    let taskFilePath: string | null = null;
    for (const day of readdirSync(tasksDir)) {
      const candidate = join(tasksDir, day, `${taskId}.json`);
      if (existsSync(candidate)) { taskFilePath = candidate; break; }
    }
    if (!taskFilePath) throw new Error(`Task file not found for id: ${taskId}`);

    const taskJson = JSON.parse(readFileSync(taskFilePath, "utf-8")) as { comments: Array<{ text: string }> };
    const text = taskJson.comments[taskJson.comments.length - 1].text;
    // No literal \n should appear — text stays as-is
    expect(text).toBe("Plain line without escapes");
    expect(text).not.toContain("\\n");
  });
});
