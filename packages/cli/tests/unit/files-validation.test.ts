import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isValidFilename,
  isAllowedFileExtension,
  validateFilename,
  MAX_FILENAME_LENGTH,
  ALLOWED_FILE_EXTENSIONS,
} from "../../src/core/files.js";

const PROTO = ".vibeflow";
const TASKS_DIR = "tasks";

function taskJson(projectDir: string, id: string) {
  return join(projectDir, PROTO, TASKS_DIR, id + ".json");
}

function writeTask(projectDir: string, task: Record<string, unknown>) {
  const dir = join(projectDir, PROTO, TASKS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    taskJson(projectDir, task.id as string),
    JSON.stringify(task, null, 2) + "\n",
  );
}

describe("isValidFilename", () => {
  it("accepts simple filenames", () => {
    expect(isValidFilename("screenshot.png")).toBe(true);
    expect(isValidFilename("my-file_v2.jpg")).toBe(true);
    expect(isValidFilename("a")).toBe(true);
    expect(isValidFilename("report-2026.csv")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidFilename("")).toBe(false);
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
  });

  it("accepts printable ASCII including spaces and unicode", () => {
    expect(isValidFilename("file name.txt")).toBe(true);
    expect(isValidFilename("日本語.png")).toBe(true);
    expect(isValidFilename("emoji😀.txt")).toBe(true);
  });

  it("rejects hidden files (leading dot)", () => {
    expect(isValidFilename(".gitignore")).toBe(false);
    expect(isValidFilename(".bashrc")).toBe(false);
    expect(isValidFilename(".env")).toBe(false);
    expect(isValidFilename(".linked.json")).toBe(false); // the reserved manifest
    expect(isValidFilename(".hidden.md")).toBe(false);
  });

  it("rejects names exceeding MAX_FILENAME_LENGTH", () => {
    const long = "a".repeat(MAX_FILENAME_LENGTH + 1);
    expect(isValidFilename(long)).toBe(false);
    expect(isValidFilename("a".repeat(MAX_FILENAME_LENGTH))).toBe(true); // exactly 255 is ok
  });

  it("rejects control characters 0x01–0x1f", () => {
    expect(isValidFilename("file\x01.txt")).toBe(false);
    expect(isValidFilename("file\x1f.txt")).toBe(false);
  });
});

describe("isAllowedFileExtension", () => {
  it("accepts all ALLOWED_FILE_EXTENSIONS", () => {
    for (const ext of ALLOWED_FILE_EXTENSIONS) {
      expect(isAllowedFileExtension("file" + ext)).toBe(true);
    }
  });

  it("rejects executable and unsafe extensions", () => {
    expect(isAllowedFileExtension("x.exe")).toBe(false);
    expect(isAllowedFileExtension("script.sh")).toBe(false);
    expect(isAllowedFileExtension("payload.dll")).toBe(false);
    expect(isAllowedFileExtension("evil.html")).toBe(false);
    expect(isAllowedFileExtension("data.xml")).toBe(false);
    expect(isAllowedFileExtension(".htaccess")).toBe(false);
  });

  it("rejects .linked.json (the manifest file)", () => {
    // .json is allowed but .linked.json is blocked at isValidFilename level
    expect(isAllowedFileExtension(".linked.json")).toBe(true); // extension is .json
    expect(isValidFilename(".linked.json")).toBe(false); // blocked as hidden file
  });

  it("is case-insensitive", () => {
    expect(isAllowedFileExtension("file.PNG")).toBe(true);
    expect(isAllowedFileExtension("file.JPEG")).toBe(true);
    expect(isAllowedFileExtension("file.Svg")).toBe(true);
  });
});

describe("validateFilename", () => {
  it("returns {valid:true} for a clean filename", () => {
    expect(validateFilename("screenshot.png")).toEqual({ valid: true });
  });

  it("returns INVALID_FILENAME for hidden files", () => {
    const result = validateFilename(".env");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("INVALID_FILENAME");
    }
  });

  it("returns INVALID_FILENAME for path traversal", () => {
    const result = validateFilename("../x.md");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("INVALID_FILENAME");
    }
  });

  it("returns INVALID_FILENAME for names too long", () => {
    const result = validateFilename("a".repeat(256));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("INVALID_FILENAME");
    }
  });

  it("returns UNSUPPORTED_FILE_TYPE for disallowed extensions", () => {
    const result = validateFilename("x.exe");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("UNSUPPORTED_FILE_TYPE");
      expect(result.errorMessage).toContain(".exe");
    }
  });

  it("returns UNSUPPORTED_FILE_TYPE for .html (XSS risk)", () => {
    const result = validateFilename("evil.html");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("UNSUPPORTED_FILE_TYPE");
    }
  });

  it("returns VALIDATION when buffer exceeds MAX_FILE_SIZE", () => {
    // Buffer size check (50 MB + 1 byte)
    const result = validateFilename("big.png", 50 * 1024 * 1024 + 1);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("VALIDATION");
      expect(result.errorMessage).toContain("too large");
    }
  });

  it("passes VALIDATION for files exactly at MAX_FILE_SIZE", () => {
    const result = validateFilename("max.png", 50 * 1024 * 1024);
    expect(result.valid).toBe(true);
  });

  it("includes suggestion list in UNSUPPORTED_FILE_TYPE error message", () => {
    const result = validateFilename("x.mp3");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorMessage).toContain(".png");
      expect(result.errorMessage).toContain(".pdf");
      expect(result.errorMessage).toContain(".svg");
    }
  });
});
