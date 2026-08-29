import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  listTasks,
  updateTask,
} from "../../src/core/tasks.js";
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
});
