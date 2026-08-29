import { describe, it, expect } from "vitest";
import { isValidTaskId, isValidCommentId, isValidFilename } from "../../../src/server/server.js";

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
    expect(isValidTaskId("a".repeat(29))).toBe(false);
    expect(isValidTaskId("a".repeat(31))).toBe(false);
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
