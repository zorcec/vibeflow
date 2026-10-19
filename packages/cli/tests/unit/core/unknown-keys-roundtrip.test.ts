import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readTaskFile,
  updateTask,
  listTasks,
} from "../../../src/core/tasks.js";
import { addComment } from "../../../src/core/comments.js";

// The local store is the lossless MIRROR push uploads: unknown/extra record
// keys must survive every read → write round trip byte-for-byte in place.
// These tests pin the audit fix in core/tasks.ts: normalization is for
// display, not record reconstruction — `...raw` comes first, and only known
// fields are rewritten. Missing authorEmail stays missing (never null/"").

describe("unknown-key round trip through load/save", () => {
  let projectDir: string;

  const writeRawTask = (record: Record<string, unknown>): string => {
    const dateDir = join(projectDir, ".vibeflow", "tasks", "2025-01-01");
    mkdirSync(dateDir, { recursive: true });
    const filePath = join(dateDir, `${record.id}.json`);
    writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
    return filePath;
  };

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "unknown-keys-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("preserves unknown keys on the task, commits, comments, files, and links through updateTask", async () => {
    const filePath = writeRawTask({
      id: "task-1",
      title: "Original",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      // Unknown at the top level (incl. fields this build's normalizeTask
      // never reconstructed, e.g. legacy or newer-writer keys):
      legacyCommit: "deadbeef",
      customObject: { nested: [1, 2, 3] },
      baselineElementFile: "baseline-element.md",
      commits: [
        {
          sha: "abc123",
          message: "m",
          timestamp: "2025-01-01T00:00:00.000Z",
          extraCommitKey: true,
        },
      ],
      comments: [
        {
          id: "c1",
          author: "user",
          text: "hello",
          createdAt: "2025-01-01T00:00:00.000Z",
          extraCommentKey: { kept: "yes" },
        },
      ],
      files: [{ name: "a.txt", addedAt: "2025-01-01T00:00:00.000Z", extraFileKey: "f" }],
      links: [{ taskId: "task-2", type: "parent", extraLinkKey: 42 }],
    });
    const before = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;

    const updated = updateTask(projectDir, "task-1", { title: "Changed" });
    expect(updated?.title).toBe("Changed");

    const after = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    expect(after.legacyCommit).toBe("deadbeef");
    expect(after.customObject).toEqual({ nested: [1, 2, 3] });
    expect(after.baselineElementFile).toBe("baseline-element.md");
    expect((after.commits as Array<Record<string, unknown>>)[0].extraCommitKey).toBe(true);
    expect((after.comments as Array<Record<string, unknown>>)[0].extraCommentKey).toEqual({ kept: "yes" });
    expect((after.files as Array<Record<string, unknown>>)[0].extraFileKey).toBe("f");
    expect((after.links as Array<Record<string, unknown>>)[0].extraLinkKey).toBe(42);
    // Same key order for the surviving keys — the record was not rebuilt.
    // `updated` is the ONE legitimate addition (updateTask stamps it); every
    // original key keeps its position and nothing else is invented.
    expect(Object.keys(after).filter((k) => k !== "updated")).toEqual(Object.keys(before));
    // Nothing was invented: no authorEmail anywhere it was not before.
    expect("authorEmail" in after).toBe(false);
  });

  it("keeps a comment authorEmail through readTaskFile and listTasks", () => {
    writeRawTask({
      id: "task-2",
      title: "T",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      comments: [
        {
          id: "c1",
          author: "user",
          text: "hi",
          createdAt: "2025-01-01T00:00:00.000Z",
          authorEmail: "author@example.com",
        },
      ],
    });
    const [task] = listTasks(projectDir);
    expect(task.comments?.[0].authorEmail).toBe("author@example.com");
  });

  it("keeps a commit authorEmail and a task-level authorEmail as-is", () => {
    writeRawTask({
      id: "task-3",
      title: "T",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      authorEmail: "task-owner@example.com",
      commits: [
        {
          sha: "abc123",
          message: "m",
          timestamp: "2025-01-01T00:00:00.000Z",
          authorEmail: "committer@example.com",
        },
      ],
    });
    const task = readTaskFile(join(projectDir, ".vibeflow", "tasks", "2025-01-01", "task-3.json"));
    expect(task?.authorEmail).toBe("task-owner@example.com");
    expect(task?.commits?.[0].authorEmail).toBe("committer@example.com");
    const updated = updateTask(projectDir, "task-3", { priority: "High" });
    expect(updated?.authorEmail).toBe("task-owner@example.com");
    expect(updated?.commits?.[0].authorEmail).toBe("committer@example.com");
  });

  it("drops an empty authorEmail instead of writing null or \"\"", () => {
    writeRawTask({
      id: "task-4",
      title: "T",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      authorEmail: "",
      commits: [{ sha: "abc123", message: "m", timestamp: "2025-01-01T00:00:00.000Z", authorEmail: "" }],
    });
    updateTask(projectDir, "task-4", { priority: "Low" });
    const text = readFileSync(join(projectDir, ".vibeflow", "tasks", "2025-01-01", "task-4.json"), "utf-8");
    expect(text).not.toContain("authorEmail");
  });

  it("addComment preserves unknown keys (read-modify-write is lossless)", async () => {
    writeRawTask({
      id: "task-5",
      title: "T",
      description: "",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      customTopLevel: "kept",
    });
    await addComment(projectDir, "task-5", "agent", "a note");
    const after = JSON.parse(
      readFileSync(join(projectDir, ".vibeflow", "tasks", "2025-01-01", "task-5.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(after.customTopLevel).toBe("kept");
    expect((after.comments as Array<Record<string, unknown>>).length).toBe(1);
  });
});
