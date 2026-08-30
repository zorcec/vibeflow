import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTask, listTasks, updateTask } from "../../src/core/tasks.js";
import { canMoveToReview } from "../../src/core/gating.js";
import { PROTO_DIR, FILES_DIR } from "../../src/core/types.js";

describe("canMoveToReview", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-gating-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns allowed: false when task does not exist", () => {
    const result = canMoveToReview(tempDir, "nonexistent-id");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Task not found");
  });

  it("returns allowed: false when task has no files", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("vibeflow verify");
  });

  it("returns allowed: false when task has files but no verification evidence", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Add a non-verification file
    updateTask(tempDir, task.id, {
      files: [{ name: "screenshot.png", addedAt: new Date().toISOString() }],
    });

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("vibeflow verify");
  });

  it("returns allowed: true when task has verification evidence in files array", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Add verification evidence file
    updateTask(tempDir, task.id, {
      files: [
        { name: "verify-after.json", addedAt: new Date().toISOString() },
        { name: "verify-diff.json", addedAt: new Date().toISOString() },
      ],
    });

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(true);
  });

  it("returns allowed: true when verification evidence exists on disk but not in task files", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Create verification evidence file on disk
    const filesDir = join(tempDir, PROTO_DIR, FILES_DIR, task.id);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(
      join(filesDir, "verify-after.json"),
      JSON.stringify({ ok: true }),
    );

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(true);
  });

  it("ignores files that don't match verify-*.json pattern", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Add files that don't match the pattern
    updateTask(tempDir, task.id, {
      files: [
        { name: "baseline.json", addedAt: new Date().toISOString() },
        { name: "screenshot.png", addedAt: new Date().toISOString() },
        { name: "verify.txt", addedAt: new Date().toISOString() }, // wrong extension
      ],
    });

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
  });

  it("handles partial task ID prefix", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Add verification evidence
    updateTask(tempDir, task.id, {
      files: [{ name: "verify-after.json", addedAt: new Date().toISOString() }],
    });

    // Use partial ID prefix
    const result = canMoveToReview(tempDir, task.id.slice(0, 8));
    expect(result.allowed).toBe(true);
  });

  it("returns allowed: false when task has files: undefined", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Explicitly set files to undefined (not empty array)
    updateTask(tempDir, task.id, { files: undefined as unknown as [] });

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("vibeflow verify");
  });

  it("returns allowed: false when task has files: [] (empty array)", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Set files to empty array
    updateTask(tempDir, task.id, { files: [] });

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("vibeflow verify");
  });

  it("returns allowed: false when files directory does not exist", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // No files array, no files directory on disk
    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("vibeflow verify");
  });

  it("handles files directory read error gracefully", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Create a file instead of a directory to trigger readdirSync error
    const filesDir = join(tempDir, PROTO_DIR, FILES_DIR, task.id);
    mkdirSync(join(tempDir, PROTO_DIR, FILES_DIR), { recursive: true });
    writeFileSync(filesDir, "not a directory");

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("vibeflow verify");
  });

  it("accepts verify-.json as valid evidence (empty name between prefix/suffix)", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Add file that matches verify-*.json pattern with empty name
    updateTask(tempDir, task.id, {
      files: [{ name: "verify-.json", addedAt: new Date().toISOString() }],
    });

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(true);
  });

  it("returns allowed: true when evidence found on disk but not in task files", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Task has non-evidence files
    updateTask(tempDir, task.id, {
      files: [{ name: "screenshot.png", addedAt: new Date().toISOString() }],
    });

    // But evidence exists on disk
    const filesDir = join(tempDir, PROTO_DIR, FILES_DIR, task.id);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(
      join(filesDir, "verify-diff.json"),
      JSON.stringify({ ok: true }),
    );

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(true);
  });

  it("rejects files with verify- prefix but wrong extension", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // File has verify- prefix but .txt extension
    updateTask(tempDir, task.id, {
      files: [
        { name: "verify-after.txt", addedAt: new Date().toISOString() },
        { name: "screenshot.png", addedAt: new Date().toISOString() },
      ],
    });

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
  });

  it("rejects files with .json extension but wrong prefix", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // File has .json extension but baseline- prefix
    updateTask(tempDir, task.id, {
      files: [
        { name: "baseline-after.json", addedAt: new Date().toISOString() },
        { name: "screenshot.png", addedAt: new Date().toISOString() },
      ],
    });

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
  });

  it("returns allowed: false when all files in array are non-evidence", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Multiple non-evidence files
    updateTask(tempDir, task.id, {
      files: [
        { name: "baseline.json", addedAt: new Date().toISOString() },
        { name: "screenshot.png", addedAt: new Date().toISOString() },
        { name: "notes.txt", addedAt: new Date().toISOString() },
      ],
    });

    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
  });

  it("finds exact task ID match among multiple tasks", () => {
    // Create two tasks
    const task1 = createTask(tempDir, {
      title: "Task without evidence",
      description: "",
      status: "in-progress",
      selector: "/",
    });
    const task2 = createTask(tempDir, {
      title: "Task with evidence",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Only task2 has evidence
    updateTask(tempDir, task2.id, {
      files: [{ name: "verify-after.json", addedAt: new Date().toISOString() }],
    });

    // Check task1 (no evidence) - should be rejected
    const result1 = canMoveToReview(tempDir, task1.id);
    expect(result1.allowed).toBe(false);

    // Check task2 (has evidence) - should be allowed
    const result2 = canMoveToReview(tempDir, task2.id);
    expect(result2.allowed).toBe(true);
  });

  it("uses exact ID match when available, falls back to prefix", () => {
    // Create a task
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Add evidence
    updateTask(tempDir, task.id, {
      files: [{ name: "verify-after.json", addedAt: new Date().toISOString() }],
    });

    // Exact match should work
    const exactResult = canMoveToReview(tempDir, task.id);
    expect(exactResult.allowed).toBe(true);

    // Prefix match should also work
    const prefixResult = canMoveToReview(tempDir, task.id.slice(0, 8));
    expect(prefixResult.allowed).toBe(true);
  });

  it("does not enter files check when task.files is undefined", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Set files to undefined
    updateTask(tempDir, task.id, { files: undefined as unknown as [] });

    // Should skip files array check and go to disk check
    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
  });

  it("does not enter files check when task.files is empty array", () => {
    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: "/",
    });

    // Set files to empty array
    updateTask(tempDir, task.id, { files: [] });

    // Should skip files array check and go to disk check
    const result = canMoveToReview(tempDir, task.id);
    expect(result.allowed).toBe(false);
  });
});
