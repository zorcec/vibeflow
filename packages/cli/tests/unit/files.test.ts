import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureFilesDir,
  listFiles,
  saveFile,
  deleteFile,
  getFilePath,
  getFileCount,
  getFilesDir,
} from "../../src/core/files.js";
import { createTask } from "../../src/core/tasks.js";

describe("files core", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-files-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getFilesDir returns correct path inside .vibeflow/tasks/files/<taskId>", () => {
    expect(getFilesDir(tempDir, "abc123")).toBe(
      join(tempDir, ".vibeflow", "tasks", "files", "abc123"),
    );
  });

  it("ensureFilesDir creates the directory", () => {
    ensureFilesDir(tempDir, "task1");
    expect(existsSync(getFilesDir(tempDir, "task1"))).toBe(true);
  });

  it("listFiles returns empty array when no directory exists", () => {
    expect(listFiles(tempDir, "missing-task")).toEqual([]);
  });

  it("listFiles returns empty array for empty directory", () => {
    ensureFilesDir(tempDir, "task1");
    expect(listFiles(tempDir, "task1")).toEqual([]);
  });

  it("saveFile stores the file and returns correct FileInfo", () => {
    const data = Buffer.from("hello world");
    const info = saveFile(tempDir, "task1", "report.md", data);
    expect(info.name).toBe("report.md");
    expect(info.size).toBe(data.length);
    expect(info.url).toBe("/api/tasks/task1/files/report.md");
  });

  it("saveFile strips path components from filename", () => {
    const data = Buffer.from("payload");
    const info = saveFile(tempDir, "task1", "../../evil.md", data);
    expect(info.name).toBe("evil.md");
    expect(info.url).toContain("evil.md");
    expect(info.url).not.toContain("..");
  });

  it("listFiles returns file after saving", () => {
    const data = Buffer.from("content");
    saveFile(tempDir, "task1", "notes.md", data);
    const files = listFiles(tempDir, "task1");
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("notes.md");
    expect(files[0].size).toBe(data.length);
    expect(files[0].url).toContain("notes.md");
  });

  it("listFiles lists multiple files", () => {
    saveFile(tempDir, "task1", "a.md", Buffer.from("a"));
    saveFile(tempDir, "task1", "b.png", Buffer.from("bb"));
    const files = listFiles(tempDir, "task1");
    expect(files).toHaveLength(2);
    const names = files.map((f) => f.name).sort();
    expect(names).toEqual(["a.md", "b.png"]);
  });

  it("listFiles for different tasks are independent", () => {
    saveFile(tempDir, "task1", "file.md", Buffer.from("t1"));
    saveFile(tempDir, "task2", "other.md", Buffer.from("t2"));
    expect(listFiles(tempDir, "task1")).toHaveLength(1);
    expect(listFiles(tempDir, "task2")).toHaveLength(1);
    expect(listFiles(tempDir, "task3")).toHaveLength(0);
  });

  it("getFilePath returns path when file exists", () => {
    saveFile(tempDir, "task1", "doc.md", Buffer.from("x"));
    const p = getFilePath(tempDir, "task1", "doc.md");
    expect(p).not.toBeNull();
    expect(p!.endsWith("doc.md")).toBe(true);
  });

  it("getFilePath returns null for non-existent file", () => {
    expect(getFilePath(tempDir, "task1", "nope.md")).toBeNull();
  });

  it("deleteFile removes the file and returns true", () => {
    saveFile(tempDir, "task1", "bye.md", Buffer.from("del"));
    expect(deleteFile(tempDir, "task1", "bye.md")).toBe(true);
    expect(listFiles(tempDir, "task1")).toHaveLength(0);
  });

  it("deleteFile returns false for non-existent file", () => {
    expect(deleteFile(tempDir, "task1", "ghost.md")).toBe(false);
  });

  it("getFileCount returns 0 when directory does not exist", () => {
    expect(getFileCount(tempDir, "no-task")).toBe(0);
  });

  it("getFileCount returns number of files", () => {
    saveFile(tempDir, "task1", "a.md", Buffer.from("a"));
    saveFile(tempDir, "task1", "b.md", Buffer.from("b"));
    expect(getFileCount(tempDir, "task1")).toBe(2);
    deleteFile(tempDir, "task1", "a.md");
    expect(getFileCount(tempDir, "task1")).toBe(1);
  });

});

// ── Uploaded-file paths require task JSON to exist for full ref coverage ──────

describe("files with task JSON (ref-based paths)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-files-ref-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("listFiles returns uploaded file via ref in task JSON (covers lines 109-118)", () => {
    // Create task JSON so setTaskFileRefs can persist refs.
    const task = createTask(tempDir, { title: "Ref task", description: "" });
    const data = Buffer.from("file content");
    saveFile(tempDir, task.id, "ref-report.md", data);

    const files = listFiles(tempDir, task.id);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("ref-report.md");
    expect(files[0].size).toBe(data.length);
    // No linkedPath for uploaded files
    expect(files[0].linkedPath).toBeUndefined();
  });

  it("deleteFile removes uploaded file via ref path (covers lines 204-206)", () => {
    const task = createTask(tempDir, { title: "Delete ref task", description: "" });
    saveFile(tempDir, task.id, "upload.txt", Buffer.from("data"));

    // Verify file ref was persisted and file exists on disk.
    expect(listFiles(tempDir, task.id)).toHaveLength(1);

    const removed = deleteFile(tempDir, task.id, "upload.txt");
    expect(removed).toBe(true);
    expect(listFiles(tempDir, task.id)).toHaveLength(0);
    // Physical file must also be gone (directory may still exist).
    expect(existsSync(join(getFilesDir(tempDir, task.id), "upload.txt"))).toBe(false);
  });

  it("getFileCount returns correct count when task JSON tracks refs", () => {
    const task = createTask(tempDir, { title: "Count task", description: "" });
    saveFile(tempDir, task.id, "a.md", Buffer.from("a"));
    saveFile(tempDir, task.id, "b.md", Buffer.from("bb"));
    expect(getFileCount(tempDir, task.id)).toBe(2);
  });

  it("saveFile deduplicates refs — saving same filename twice keeps one ref", () => {
    const task = createTask(tempDir, { title: "Dedup task", description: "" });
    saveFile(tempDir, task.id, "dup.md", Buffer.from("v1"));
    saveFile(tempDir, task.id, "dup.md", Buffer.from("v2"));
    expect(getFileCount(tempDir, task.id)).toBe(1);
  });
});

// ── Legacy .linked.json migration ─────────────────────────────────────────────

describe("legacy .linked.json migration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-linked-legacy-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("migrates entries from .linked.json into task refs on listFiles", () => {
    const task = createTask(tempDir, { title: "Legacy linked task", description: "" });
    const externalPath = join(tempDir, "legacy-doc.md");
    writeFileSync(externalPath, "legacy content", "utf-8");

    // Manually create the legacy .linked.json manifest.
    ensureFilesDir(tempDir, task.id);
    const manifestPath = join(getFilesDir(tempDir, task.id), ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([{ name: "legacy-doc.md", path: externalPath }]), "utf-8");

    const files = listFiles(tempDir, task.id);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("legacy-doc.md");
    expect(files[0].linkedPath).toBe(externalPath);

    // Manifest should be cleaned up after migration.
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("cleans up an empty .linked.json manifest without adding refs", () => {
    const task = createTask(tempDir, { title: "Empty manifest task", description: "" });
    ensureFilesDir(tempDir, task.id);
    const manifestPath = join(getFilesDir(tempDir, task.id), ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([]), "utf-8");

    const files = listFiles(tempDir, task.id);
    expect(files).toHaveLength(0);
    // Empty manifest should be removed.
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("handles corrupted .linked.json gracefully (returns empty)", () => {
    const task = createTask(tempDir, { title: "Corrupt manifest task", description: "" });
    ensureFilesDir(tempDir, task.id);
    const manifestPath = join(getFilesDir(tempDir, task.id), ".linked.json");
    writeFileSync(manifestPath, "not valid json {{", "utf-8");

    // Should not throw; returns empty list.
    const files = listFiles(tempDir, task.id);
    expect(files).toHaveLength(0);
  });

  it("migrates legacy entry when linked file no longer exists on disk", () => {
    const task = createTask(tempDir, { title: "Missing linked file", description: "" });
    const missingPath = join(tempDir, "deleted-doc.md");
    // Don't create the file — it's "missing"

    ensureFilesDir(tempDir, task.id);
    const manifestPath = join(getFilesDir(tempDir, task.id), ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([{ name: "deleted-doc.md", path: missingPath }]), "utf-8");

    const files = listFiles(tempDir, task.id);
    // File doesn't exist on disk, so it shouldn't appear in list
    expect(files).toHaveLength(0);
    // But migration should still run and clean up manifest
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("deleteFile does not delete physical file for linked refs", () => {
    const task = createTask(tempDir, { title: "Linked delete task", description: "" });
    const externalPath = join(tempDir, "linked-keep.md");
    writeFileSync(externalPath, "linked content", "utf-8");

    ensureFilesDir(tempDir, task.id);
    const manifestPath = join(getFilesDir(tempDir, task.id), ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([{ name: "linked-keep.md", path: externalPath }]), "utf-8");

    // Trigger migration
    listFiles(tempDir, task.id);

    // Delete the linked file ref
    const removed = deleteFile(tempDir, task.id, "linked-keep.md");
    expect(removed).toBe(true);

    // External file should NOT be deleted (it's linked, not uploaded)
    expect(existsSync(externalPath)).toBe(true);
  });

  it("getFilePath returns linked path when linked file exists", () => {
    const task = createTask(tempDir, { title: "Linked path task", description: "" });
    const externalPath = join(tempDir, "linked-get.md");
    writeFileSync(externalPath, "linked content", "utf-8");

    ensureFilesDir(tempDir, task.id);
    const manifestPath = join(getFilesDir(tempDir, task.id), ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([{ name: "linked-get.md", path: externalPath }]), "utf-8");

    // Trigger migration
    listFiles(tempDir, task.id);

    const result = getFilePath(tempDir, task.id, "linked-get.md");
    expect(result).toBe(externalPath);
  });

  it("getFilePath returns null when linked ref exists but file is missing", () => {
    const task = createTask(tempDir, { title: "Missing linked path", description: "" });
    const missingPath = join(tempDir, "gone.md");

    ensureFilesDir(tempDir, task.id);
    const manifestPath = join(getFilesDir(tempDir, task.id), ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([{ name: "gone.md", path: missingPath }]), "utf-8");

    // Trigger migration
    listFiles(tempDir, task.id);

    const result = getFilePath(tempDir, task.id, "gone.md");
    expect(result).toBeNull();
  });

  it("listFiles includes files on disk that have no refs (backward compat)", () => {
    const task = createTask(tempDir, { title: "Orphan file task", description: "" });
    ensureFilesDir(tempDir, task.id);

    // Write a file directly without using saveFile (no ref)
    const orphanPath = join(getFilesDir(tempDir, task.id), "orphan.png");
    writeFileSync(orphanPath, Buffer.from("orphan-data"));

    const files = listFiles(tempDir, task.id);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("orphan.png");
    expect(files[0].linkedPath).toBeUndefined();
  });

  it("listFiles deduplicates: linked ref takes precedence over orphan file with same name", () => {
    const task = createTask(tempDir, { title: "Dedup task", description: "" });
    const externalPath = join(tempDir, "shared.md");
    writeFileSync(externalPath, "linked version", "utf-8");

    ensureFilesDir(tempDir, task.id);
    // Create legacy manifest
    const manifestPath = join(getFilesDir(tempDir, task.id), ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([{ name: "shared.md", path: externalPath }]), "utf-8");
    // Also create an orphan file with same name
    writeFileSync(join(getFilesDir(tempDir, task.id), "shared.md"), "orphan version", "utf-8");

    const files = listFiles(tempDir, task.id);
    expect(files).toHaveLength(1);
    // Linked ref should win
    expect(files[0].linkedPath).toBe(externalPath);
  });

  it("migrateLegacyLinkedRefs skips entries already present in refs", () => {
    const task = createTask(tempDir, { title: "Already migrated", description: "" });
    const externalPath = join(tempDir, "already-linked.md");
    writeFileSync(externalPath, "content", "utf-8");

    // Find the task file and manually add a ref (simulating already-migrated state)
    const taskPath = join(tempDir, ".vibeflow", "tasks");
    const entries = readdirSync(taskPath, { withFileTypes: true });
    const dateDir = entries.find((e) => e.isDirectory())?.name;
    const taskFile = join(taskPath, dateDir!, `${task.id}.json`);
    const taskData = JSON.parse(readFileSync(taskFile, "utf-8"));
    taskData.files = [{ name: "already-linked.md", linkedPath: externalPath, addedAt: new Date().toISOString() }];
    writeFileSync(taskFile, JSON.stringify(taskData, null, 2), "utf-8");

    // Create legacy manifest with same entry
    ensureFilesDir(tempDir, task.id);
    const manifestPath = join(getFilesDir(tempDir, task.id), ".linked.json");
    writeFileSync(manifestPath, JSON.stringify([{ name: "already-linked.md", path: externalPath }]), "utf-8");

    const files = listFiles(tempDir, task.id);
    expect(files).toHaveLength(1);
    expect(files[0].linkedPath).toBe(externalPath);
    // Manifest should be cleaned up
    expect(existsSync(manifestPath)).toBe(false);
  });
});
