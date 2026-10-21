import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listComments,
  addComment as coreAddComment,
  updateComment,
  deleteComment,
  normalizeCommentText,
} from "../../src/core/comments.js";
import type { TaskComment } from "../../src/core/types.js";
import { findTaskFilePath, readTaskRecordFile } from "../../src/core/tasks.js";
// Success-path comment tests need a real canonical task, not an orphan shell.
async function addComment(...args: Parameters<typeof coreAddComment>): ReturnType<typeof coreAddComment> {
  const [dir, id] = args;
  if (!findTaskFilePath(dir, id)) {
    const root = join(dir, ".vibeflow", "tasks");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${id}.json`), JSON.stringify({ id, title: "Comment test task", status: "todo", created: "2026-01-01T00:00:00Z" }));
  }
  return coreAddComment(...args);
}

describe("listComments", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-comments-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when no comments file exists", () => {
    expect(listComments(tempDir, "nonexistent-id")).toEqual([]);
  });

  it("returns empty array when .vibeflow/comments dir does not exist", () => {
    // No ensureCommentsDir call — directory doesn't exist
    expect(listComments(tempDir, "task-id")).toEqual([]);
  });
});

describe("addComment", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-comments-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates comments file and returns the new comment", async () => {
    const comment = await addComment(
      tempDir,
      "task-123",
      "user",
      "This looks great",
    );
    expect(comment.author).toBe("user");
    expect(comment.text).toBe("This looks great");
    expect(comment.createdAt).toBeTruthy();
  });

  it("appends to existing comments", async () => {
    await addComment(tempDir, "task-abc", "user", "First comment");
    await addComment(tempDir, "task-abc", "agent", "Second comment");
    const comments = listComments(tempDir, "task-abc");
    expect(comments).toHaveLength(2);
    expect(comments[0].text).toBe("First comment");
    expect(comments[1].text).toBe("Second comment");
  });

  it("supports both user and agent authors", async () => {
    const userComment = await addComment(tempDir, "t1", "user", "User msg");
    const agentComment = await addComment(tempDir, "t2", "agent", "Agent msg");
    expect(userComment.author).toBe("user");
    expect(agentComment.author).toBe("agent");
  });

  it("comments for different tasks are stored independently", async () => {
    await addComment(tempDir, "task-A", "user", "For A");
    await addComment(tempDir, "task-B", "user", "For B");
    expect(listComments(tempDir, "task-A")).toHaveLength(1);
    expect(listComments(tempDir, "task-B")).toHaveLength(1);
    expect(listComments(tempDir, "task-A")[0].text).toBe("For A");
  });

  it("comment has a valid ISO createdAt timestamp", async () => {
    const comment = await addComment(tempDir, "t1", "user", "Hello");
    expect(() => new Date(comment.createdAt).toISOString()).not.toThrow();
  });

  it("includes files attachment when provided", async () => {
    const comment = await addComment(
      tempDir,
      "task-f",
      "user",
      "see attached",
      ["file.png"],
    );
    expect(comment.files).toEqual(["file.png"]);
  });

  it("includes type when a non-comment type is provided", async () => {
    const comment = await addComment(
      tempDir,
      "task-t",
      "user",
      "system event",
      undefined,
      "system",
    );
    expect(comment.type).toBe("system");
  });

  it("addComment for non-existent task still persists the comment", async () => {
    // This exercises the fallback branch in addComment when updateTask returns null.
    // The task file doesn't exist (no task was created in tempDir).
    const fakeTaskId = "non-existent-task-abc";
    const comment = await coreAddComment(
      tempDir,
      fakeTaskId,
      "user",
      "orphan comment",
    );
    expect(comment.text).toBe("orphan comment");
    const path = findTaskFilePath(tempDir, fakeTaskId)!;
    const before = readFileSync(path, "utf8");
    expect(JSON.parse(before).comments[0].text).toBe("orphan comment");
    expect(readTaskRecordFile(path).record).toBeNull();
    expect(listComments(tempDir, fakeTaskId)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("generates unique ids", async () => {
    const c1 = await addComment(tempDir, "task-1", "user", "a");
    const c2 = await addComment(tempDir, "task-1", "user", "b");
    expect(c1.id).toBeTruthy();
    expect(c2.id).toBeTruthy();
    expect(c1.id).not.toBe(c2.id);
  });

  it("does not include files field when empty array provided", async () => {
    const comment = await addComment(
      tempDir,
      "task-empty-files",
      "user",
      "no files",
      [],
    );
    expect(comment.files).toBeUndefined();
  });

  it("does not include type field when type is .comment.", async () => {
    const comment = await addComment(
      tempDir,
      "task-type-comment",
      "user",
      "normal comment",
      undefined,
      "comment",
    );
    expect(comment.type).toBeUndefined();
  });

  it("includes source field when explicitly provided", async () => {
    const comment = await addComment(
      tempDir,
      "task-source",
      "user",
      "from saas",
      undefined,
      undefined,
      "saas",
    );
    expect(comment.source).toBe("saas");
  });

  it("defaults source to .cli. when not provided", async () => {
    const comment = await addComment(
      tempDir,
      "task-default-source",
      "user",
      "default source",
    );
    expect(comment.source).toBe("cli");
  });

  it("handles empty text", async () => {
    const comment = await addComment(tempDir, "task-empty-text", "user", "");
    expect(comment.text).toBe("");
  });
});

describe("updateComment", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-comments-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("updates text of a comment with matching id", async () => {
    const comment = await addComment(
      tempDir,
      "task-1",
      "user",
      "original text",
    );
    const updated = await updateComment(
      tempDir,
      "task-1",
      comment.id!,
      "new text",
    );
    expect(updated).not.toBeNull();
    expect(updated!.text).toBe("new text");
    expect(updated!.updatedAt).toBeTruthy();
  });

  it("persists update to disk", async () => {
    const comment = await addComment(tempDir, "task-1", "user", "original");
    await updateComment(tempDir, "task-1", comment.id!, "updated");
    const comments = listComments(tempDir, "task-1");
    expect(comments[0].text).toBe("updated");
  });

  it("returns null when commentId does not exist", async () => {
    await addComment(tempDir, "task-1", "user", "text");
    const result = await updateComment(
      tempDir,
      "task-1",
      "nonexistent-id",
      "new",
    );
    expect(result).toBeNull();
  });

  it("does not modify other comments", async () => {
    const c1 = await addComment(tempDir, "task-1", "user", "first");
    const c2 = await addComment(tempDir, "task-1", "user", "second");
    await updateComment(tempDir, "task-1", c1.id!, "updated first");
    const comments = listComments(tempDir, "task-1");
    expect(comments[1].text).toBe("second");
    expect(comments[1].id).toBe(c2.id);
  });

  it("returns null when trying to update a deleted comment", async () => {
    const comment = await addComment(tempDir, "task-1", "user", "to delete");
    await deleteComment(tempDir, "task-1", comment.id!);
    const result = await updateComment(
      tempDir,
      "task-1",
      comment.id!,
      "new text",
    );
    expect(result).toBeNull();
  });
});

describe("deleteComment", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-comments-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes comment with matching id and returns true", async () => {
    const comment = await addComment(tempDir, "task-1", "user", "to delete");
    const result = await deleteComment(tempDir, "task-1", comment.id!);
    expect(result).toBe(true);
    expect(listComments(tempDir, "task-1")).toHaveLength(0);
  });

  it("returns false when commentId does not exist", async () => {
    await addComment(tempDir, "task-1", "user", "text");
    const result = await deleteComment(tempDir, "task-1", "nonexistent-id");
    expect(result).toBe(false);
  });

  it("does not remove other comments", async () => {
    const c1 = await addComment(tempDir, "task-1", "user", "keep");
    const c2 = await addComment(tempDir, "task-1", "user", "delete me");
    await deleteComment(tempDir, "task-1", c2.id!);
    const remaining = listComments(tempDir, "task-1");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(c1.id);
  });

  it("returns false when trying to delete an already-deleted comment", async () => {
    const comment = await addComment(tempDir, "task-1", "user", "to delete");
    expect(await deleteComment(tempDir, "task-1", comment.id!)).toBe(true);
    expect(await deleteComment(tempDir, "task-1", comment.id!)).toBe(false);
  });

  it("soft-deleted comments are not returned by listComments", async () => {
    await addComment(tempDir, "task-1", "user", "visible");
    const c2 = await addComment(tempDir, "task-1", "user", "will be deleted");
    await deleteComment(tempDir, "task-1", c2.id!);
    const comments = listComments(tempDir, "task-1");
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("visible");
  });
});

describe("normalizeCommentText", () => {
  it("converts literal \\n to actual newline", () => {
    expect(normalizeCommentText("line1\\nline2")).toBe("line1\nline2");
  });

  it("converts multiple \\n sequences", () => {
    expect(normalizeCommentText("para1\\n\\npara2")).toBe("para1\n\npara2");
  });

  it("converts \\t to actual tab", () => {
    expect(normalizeCommentText("key\\tvalue")).toBe("key\tvalue");
  });

  it("converts \\r to actual carriage return", () => {
    expect(normalizeCommentText("line\\r\\n")).toBe("line\r\n");
  });

  it("converts \\\\ to single backslash", () => {
    expect(normalizeCommentText("path\\\\file")).toBe("path\\file");
  });

  it("leaves plain text unchanged", () => {
    expect(normalizeCommentText("Hello world")).toBe("Hello world");
  });

  it("leaves empty string unchanged", () => {
    expect(normalizeCommentText("")).toBe("");
  });

  it("leaves text with actual newlines unchanged (idempotent)", () => {
    const text = "line1\nline2\n\npara2";
    expect(normalizeCommentText(text)).toBe(text);
  });

  it("handles \\\\n correctly: double-backslash + n -> backslash + n literal", () => {
    // \\n means the user intended a literal backslash followed by n (not a newline)
    expect(normalizeCommentText("\\\\n")).toBe("\\n");
  });

  it("handles mixed actual newlines and literal \\n sequences", () => {
    // real newline + literal \n -> real newline + real newline
    expect(normalizeCommentText("real\n" + "literal\\n")).toBe(
      "real\nliteral\n",
    );
  });

  it("handles typical agent markdown comment with \\n\\n bullets", () => {
    const agentComment =
      "Implemented X:\\n\\n- Removed command\\n- Deleted file\\n- Updated tests";
    expect(normalizeCommentText(agentComment)).toBe(
      "Implemented X:\n\n- Removed command\n- Deleted file\n- Updated tests",
    );
  });

  it("handles \\n at start and end of string", () => {
    expect(normalizeCommentText("\\nfoo\\n")).toBe("\nfoo\n");
  });

  it("handles only escape sequences", () => {
    expect(normalizeCommentText("\\n\\t\\r")).toBe("\n\t\r");
  });

  it("does not touch unknown escape sequences like \\b or \\f", () => {
    // Only n, t, r, \\ are mapped; others are passed through unchanged
    expect(normalizeCommentText("\\b")).toBe("\\b");
    expect(normalizeCommentText("\\f")).toBe("\\f");
  });
});

describe("addComment text normalization", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-comments-normalize-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("normalizes literal \\n in comment text on add", async () => {
    const comment = await addComment(
      tempDir,
      "task-1",
      "agent",
      "line1\\nline2",
    );
    expect(comment.text).toBe("line1\nline2");
    const persisted = listComments(tempDir, "task-1");
    expect(persisted[0].text).toBe("line1\nline2");
  });

  it("normalizes agent-style markdown comment on add", async () => {
    const raw = "Implemented X:\\n\\n- Did A\\n- Did B";
    const comment = await addComment(tempDir, "task-2", "agent", raw);
    expect(comment.text).toBe("Implemented X:\n\n- Did A\n- Did B");
  });

  it("normalizes literal \\n in comment text on update", async () => {
    const comment = await addComment(tempDir, "task-3", "user", "initial");
    const updated = await updateComment(
      tempDir,
      "task-3",
      comment.id!,
      "updated\\nline2",
    );
    expect(updated!.text).toBe("updated\nline2");
    const persisted = listComments(tempDir, "task-3");
    expect(persisted[0].text).toBe("updated\nline2");
  });

  it("plain text is stored as-is when no escape sequences present", async () => {
    const comment = await addComment(
      tempDir,
      "task-4",
      "user",
      "just plain text",
    );
    expect(comment.text).toBe("just plain text");
  });
});

describe("listComments: legacy comment normalization", () => {
  // These tests verify that comments stored in non-standard formats (e.g. by agents
  // that wrote to task JSON directly) are normalized on read so the rest of the code
  // can rely on `text` and `author` always being present.
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-comments-legacy-test-"));
    mkdirSync(join(tempDir, ".vibeflow", "tasks", "2026-04-10"), {
      recursive: true,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const writeTask = (id: string, comments: object[]) => {
    writeFileSync(
      join(tempDir, ".vibeflow", "tasks", "2026-04-10", `${id}.json`),
      JSON.stringify({
        id,
        title: "Test",
        description: "",
        status: "todo",
        selector: "/",
        created: "2026-04-10T10:00:00.000Z",
        comments,
      }),
      "utf-8",
    );
  };

  it("quarantines conflicting empty text/body without changing bytes", () => {
    writeTask("task-legacy-body", [
      {
        id: "c1",
        body: "Content from body field",
        createdAt: "2026-04-10T10:00:00.000Z",
        text: "",
      },
    ]);
    const path = findTaskFilePath(tempDir, "task-legacy-body")!;
    const before = readFileSync(path, "utf8");
    expect(listComments(tempDir, "task-legacy-body")).toEqual([]);
    expect(readTaskRecordFile(path).issues.length).toBeGreaterThan(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("quarantines differing text/body without choosing one", () => {
    writeTask("task-prefer-text", [
      {
        id: "c1",
        body: "body value",
        text: "text value",
        createdAt: "2026-04-10T10:00:00.000Z",
      },
    ]);
    const path = findTaskFilePath(tempDir, "task-prefer-text")!;
    const before = readFileSync(path, "utf8");
    expect(listComments(tempDir, "task-prefer-text")).toEqual([]);
    expect(readTaskRecordFile(path).issues.length).toBeGreaterThan(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("quarantines a missing author instead of inventing attribution", () => {
    writeTask("task-no-author", [
      { id: "c1", text: "some comment", createdAt: "2026-04-10T10:00:00.000Z" },
    ]);
    const path = findTaskFilePath(tempDir, "task-no-author")!;
    const before = readFileSync(path, "utf8");
    expect(listComments(tempDir, "task-no-author")).toEqual([]);
    expect(readTaskRecordFile(path).issues.length).toBeGreaterThan(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("preserves existing author when present", () => {
    writeTask("task-has-author", [
      {
        id: "c1",
        author: "user",
        text: "user comment",
        createdAt: "2026-04-10T10:00:00.000Z",
      },
    ]);
    const comments = listComments(tempDir, "task-has-author");
    expect(comments[0].author).toBe("user");
  });

  it("quarantines missing author plus conflicting text/body", () => {
    writeTask("task-both-missing", [
      {
        id: "c1",
        body: "legacy content",
        createdAt: "2026-04-10T10:00:00.000Z",
        text: "",
      },
    ]);
    const path = findTaskFilePath(tempDir, "task-both-missing")!;
    const before = readFileSync(path, "utf8");
    expect(listComments(tempDir, "task-both-missing")).toEqual([]);
    expect(readTaskRecordFile(path).issues.length).toBeGreaterThan(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
