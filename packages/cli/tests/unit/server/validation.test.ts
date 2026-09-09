import { describe, it, expect } from "vitest";
import { isValidTaskId, isValidCommentId } from "../../../src/server/server.js";
import {
  isValidFilename,
  isAllowedFileExtension,
  validateFilename,
  MAX_FILENAME_LENGTH,
  ALLOWED_FILE_EXTENSIONS,
} from "../../../src/core/files.js";

describe("isValidTaskId", () => {
  it("accepts a 30-character hex string", () => {
    expect(isValidTaskId("a".repeat(30))).toBe(true);
    expect(isValidTaskId("0123456789abcdef".repeat(2).slice(0, 30))).toBe(true);
  });

  it("rejects non-hex characters", () => {
    expect(isValidTaskId("g".repeat(30))).toBe(false);
    expect(isValidTaskId("../etc/passwd")).toBe(false);
  });

  it("rejects wrong lengths", () => {
    expect(isValidTaskId("a".repeat(7))).toBe(false);
    expect(isValidTaskId("a".repeat(9))).toBe(false);
    expect(isValidTaskId("a".repeat(29))).toBe(false);
    expect(isValidTaskId("a".repeat(31))).toBe(false);
    expect(isValidTaskId("")).toBe(false);
  });

  it("accepts legacy 8-character hex IDs (regression: 400 on files API)", () => {
    // Real legacy task from vibeflow-private — GET /api/tasks/130ed97a/files
    // returned 400 "Invalid task id" before the validator accepted this format.
    expect(isValidTaskId("130ed97a")).toBe(true);
    expect(isValidTaskId("02ac47ce")).toBe(true);
  });
});

describe("isValidCommentId", () => {
  it("accepts a 16-character hex string", () => {
    expect(isValidCommentId("a".repeat(16))).toBe(true);
    expect(isValidCommentId("0123456789abcdef")).toBe(true);
  });

  it("rejects non-hex characters", () => {
    expect(isValidCommentId("g".repeat(16))).toBe(false);
    expect(isValidCommentId("../../../etc/pas")).toBe(false);
  });

  it("rejects wrong lengths", () => {
    expect(isValidCommentId("a".repeat(15))).toBe(false);
    expect(isValidCommentId("a".repeat(17))).toBe(false);
    expect(isValidCommentId("")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidCommentId("..%2F..%2Fetc%2Fpas")).toBe(false);
    expect(isValidCommentId("../etc/passwd")).toBe(false);
    expect(isValidCommentId("..\\..\\windows")).toBe(false);
  });

  it("accepts legacy SaaS-era IDs (regression: 400 on comment PATCH/DELETE)", () => {
    // Real legacy comment IDs from vibeflow-private — PATCH/DELETE
    // /api/tasks/130ed97a/comments/mnrrhpi0f9mxv returned 400
    // "Invalid comment id" before the validator accepted this format.
    expect(isValidCommentId("mnrrhpi0f9mxv")).toBe(true);
    expect(isValidCommentId("mntcmygmsrclz")).toBe(true);
    expect(isValidCommentId("mntdgjypsaxpy")).toBe(true);
    expect(isValidCommentId("3839427352")).toBe(true);
    expect(isValidCommentId("d0r4230cfc")).toBe(true);
    expect(isValidCommentId("mn12veccleanup")).toBe(true);
  });

  it("accepts legacy hand-written slug IDs", () => {
    // Agents wrote these IDs straight into task JSON (against policy),
    // but they are real stored IDs — the server must not 400 them.
    expect(isValidCommentId("fix-comment-1")).toBe(true);
    expect(isValidCommentId("align_impl")).toBe(true);
    expect(isValidCommentId("liveview-research-v2")).toBe(true);
    expect(isValidCommentId("selector-review-1773840898311")).toBe(true);
  });

  it("still rejects empty and over-long slug IDs", () => {
    expect(isValidCommentId("")).toBe(false);
    expect(isValidCommentId(`${"a".repeat(64)}-x`)).toBe(false);
  });
});

describe("isValidFilename", () => {
  it("accepts simple filenames", () => {
    expect(isValidFilename("screenshot.png")).toBe(true);
    expect(isValidFilename("my-file_v2.jpg")).toBe(true);
    expect(isValidFilename("a")).toBe(true);
  });

  it("rejects forward slash", () => {
    expect(isValidFilename("../../../etc/passwd")).toBe(false);
    expect(isValidFilename("dir/file.txt")).toBe(false);
  });

  it("rejects backslash", () => {
    expect(isValidFilename("..\\..\\windows\\system32")).toBe(false);
    expect(isValidFilename("dir\\file.txt")).toBe(false);
  });

  it("rejects dot-dot traversal", () => {
    expect(isValidFilename("..")).toBe(false);
    expect(isValidFilename(".")).toBe(false);
    expect(isValidFilename("file..name.txt")).toBe(false);
  });

  it("rejects null bytes", () => {
    expect(isValidFilename("file\0.txt")).toBe(false);
    expect(isValidFilename("\0")).toBe(false);
  });

  it("rejects control characters below 0x20", () => {
    expect(isValidFilename("file\n.txt")).toBe(false);
    expect(isValidFilename("file\r.txt")).toBe(false);
    expect(isValidFilename("file\t.txt")).toBe(false);
    expect(isValidFilename("file\x00.txt")).toBe(false);
    expect(isValidFilename("file\x1f.txt")).toBe(false);
  });

  it("accepts printable ASCII and above", () => {
    expect(isValidFilename("file name.txt")).toBe(true);
    expect(isValidFilename("日本語.png")).toBe(true);
    expect(isValidFilename("emoji😀.txt")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidFilename("")).toBe(false);
  });
});
