import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appRouter } from "../../../src/server/trpc.js";
import { createTask } from "../../../src/core/tasks.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));
import { addComment, deleteComment } from "../../../src/core/comments.js";
import { saveFile } from "../../../src/core/files.js";

describe("appRouter tRPC", () => {
  let tempDir: string;
  let broadcast: ReturnType<typeof vi.fn>;
  let caller: ReturnType<typeof appRouter.createCaller>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-trpc-test-"));
    broadcast = vi.fn();
    caller = appRouter.createCaller({ projectDir: tempDir, broadcast });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("project", () => {
    it("returns project name and directory", async () => {
      const result = await caller.project();
      expect(result.name).toBeTruthy();
      expect(result.projectDir).toBe(tempDir);
    });
  });

  describe("tasks", () => {
    it("returns tasks with comment and file counts", async () => {
      const task = createTask(tempDir, { title: "Task with meta", selector: "#a" });
      addComment(tempDir, task.id, "user", "first");
      addComment(tempDir, task.id, "user", "second");
      deleteComment(tempDir, task.id, addComment(tempDir, task.id, "user", "deleted").id);
      saveFile(tempDir, task.id, "notes.md", Buffer.from("hello"));

      const { tasks } = await caller.tasks();
      const found = tasks.find((t) => t.id === task.id);
      expect(found).toBeDefined();
      expect(found?.commentCount).toBe(2);
      expect(found?.fileCount).toBe(1);
    });

    it("returns empty list when no tasks exist", async () => {
      const { tasks } = await caller.tasks();
      expect(tasks).toEqual([]);
    });
  });

  describe("searchTasks", () => {
    it("filters by query and includes counts", async () => {
      createTask(tempDir, { title: "Alpha task", selector: "#a" });
      const beta = createTask(tempDir, { title: "Beta task", selector: "#b" });
      addComment(tempDir, beta.id, "user", "note");
      saveFile(tempDir, beta.id, "img.png", Buffer.from("x"));

      const { results } = await caller.searchTasks({ query: "beta" });
      expect(results).toHaveLength(1);
      expect(results[0].task.title).toBe("Beta task");
      expect(results[0].commentCount).toBe(1);
      expect(results[0].fileCount).toBe(1);
    });

    it("respects limit", async () => {
      createTask(tempDir, { title: "Alpha task", selector: "#a" });
      createTask(tempDir, { title: "Beta task", selector: "#b" });

      const { results } = await caller.searchTasks({ query: "task", limit: 1 });
      expect(results).toHaveLength(1);
    });
  });

  describe("createTask", () => {
    it("creates a task and broadcasts an update", async () => {
      const result = await caller.createTask({
        title: "New task",
        selector: "#new",
        description: "Details",
      });

      expect(result.success).toBe(true);
      expect(result.task.title).toBe("New task");
      expect(broadcast).toHaveBeenCalledWith({ type: "tasks-updated" });
    });

    it("defaults status to todo", async () => {
      const result = await caller.createTask({ title: "Default status", selector: "#x" });
      expect(result.task.status).toBe("todo");
    });
  });

  describe("updateTask", () => {
    it("updates allowed fields including tags, sortKey, and branchName", async () => {
      const task = createTask(tempDir, { title: "Updatable", selector: "#u" });

      const result = await caller.updateTask({
        id: task.id,
        updates: {
          status: "in-progress",
          tags: ["frontend", "urgent"],
          sortKey: "1",
          branchName: "feature/abc",
        },
      });

      expect(result.success).toBe(true);
      expect(result.task.status).toBe("in-progress");
      expect(result.task.tags).toEqual(["frontend", "urgent"]);
      expect(result.task.sortKey).toBe("1");
      expect(result.task.branchName).toBe("feature/abc");
      expect(broadcast).toHaveBeenCalledWith({ type: "tasks-updated" });
    });

    it("throws NOT_FOUND for missing task", async () => {
      await expect(
        caller.updateTask({ id: "missing-id", updates: { title: "x" } }),
      ).rejects.toThrow("Task not found");
    });
  });

  describe("deleteTask", () => {
    it("deletes an existing task", async () => {
      const task = createTask(tempDir, { title: "To delete", selector: "#d" });
      const result = await caller.deleteTask({ id: task.id });
      expect(result.success).toBe(true);
      expect(broadcast).toHaveBeenCalledWith({ type: "tasks-updated" });
    });

    it("throws NOT_FOUND for missing task", async () => {
      await expect(caller.deleteTask({ id: "missing-id" })).rejects.toThrow("Task not found");
    });
  });

  describe("comments", () => {
    it("lists comments for a task", async () => {
      const task = createTask(tempDir, { title: "Commented", selector: "#c" });
      addComment(tempDir, task.id, "user", "hello");

      const { comments } = await caller.comments({ id: task.id });
      expect(comments).toHaveLength(1);
      expect(comments[0].text).toBe("hello");
    });
  });

  describe("addComment", () => {
    it("adds a comment and broadcasts", async () => {
      const task = createTask(tempDir, { title: "Add comment", selector: "#ac" });
      const result = await caller.addComment({ taskId: task.id, text: "  note  " });

      expect(result.success).toBe(true);
      expect(result.comment.text).toBe("note");
      expect(broadcast).toHaveBeenCalledWith({ type: "tasks-updated" });
    });
  });

  describe("updateComment", () => {
    it("updates comment text", async () => {
      const task = createTask(tempDir, { title: "Update comment", selector: "#uc" });
      const comment = addComment(tempDir, task.id, "user", "original");

      const result = await caller.updateComment({
        taskId: task.id,
        commentId: comment.id,
        text: "updated",
      });

      expect(result.comment.text).toBe("updated");
    });

    it("throws NOT_FOUND for missing comment", async () => {
      const task = createTask(tempDir, { title: "x", selector: "#x" });
      await expect(
        caller.updateComment({ taskId: task.id, commentId: "missing", text: "x" }),
      ).rejects.toThrow("Comment not found");
    });
  });

  describe("deleteComment", () => {
    it("deletes a comment and broadcasts", async () => {
      const task = createTask(tempDir, { title: "Delete comment", selector: "#dc" });
      const comment = addComment(tempDir, task.id, "user", "bye");

      const result = await caller.deleteComment({ taskId: task.id, commentId: comment.id });
      expect(result.success).toBe(true);
      expect(broadcast).toHaveBeenCalledWith({ type: "tasks-updated" });
    });
  });

  describe("files", () => {
    it("lists files attached to a task", async () => {
      const task = createTask(tempDir, { title: "With file", selector: "#f" });
      saveFile(tempDir, task.id, "doc.txt", Buffer.from("data"));

      const { files } = await caller.files({ id: task.id });
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe("doc.txt");
    });
  });

  describe("models", () => {
    it("returns an error when opencode is not available", async () => {
      const { execSync } = await import("node:child_process");
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error("command not found");
      });

      const result = await caller.models();
      expect(result.error).toBeTruthy();
      expect(result.models).toEqual([]);
    });
  });
});
