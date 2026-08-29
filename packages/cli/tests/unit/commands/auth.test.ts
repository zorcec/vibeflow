import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearAuthState, listAuthStateFiles } from "../../../src/commands/auth.js";
import { PROTO_DIR } from "../../../src/core/types.js";

describe("clearAuthState", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-auth-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns 0 when no auth files exist", () => {
    const deleted = clearAuthState(tempDir);
    expect(deleted).toBe(0);
  });

  it("returns 0 when .vibeflow directory does not exist", () => {
    const deleted = clearAuthState(join(tempDir, "nonexistent"));
    expect(deleted).toBe(0);
  });

  it("deletes all per-task auth state files", () => {
    const protoDir = join(tempDir, PROTO_DIR);
    mkdirSync(protoDir, { recursive: true });

    // Create auth state files
    writeFileSync(join(protoDir, "auth-state.abc123.enc"), "encrypted-data-1");
    writeFileSync(join(protoDir, "auth-state.def456.enc"), "encrypted-data-2");
    writeFileSync(join(protoDir, "auth-state.ghi789.enc"), "encrypted-data-3");

    // Create a non-auth file that should NOT be deleted
    writeFileSync(join(protoDir, "config.json"), "{}");

    const deleted = clearAuthState(tempDir);
    expect(deleted).toBe(3);

    // Verify auth files are deleted
    expect(existsSync(join(protoDir, "auth-state.abc123.enc"))).toBe(false);
    expect(existsSync(join(protoDir, "auth-state.def456.enc"))).toBe(false);
    expect(existsSync(join(protoDir, "auth-state.ghi789.enc"))).toBe(false);

    // Verify non-auth file is preserved
    expect(existsSync(join(protoDir, "config.json"))).toBe(true);
  });

  it("handles files that are already deleted gracefully", () => {
    const protoDir = join(tempDir, PROTO_DIR);
    mkdirSync(protoDir, { recursive: true });

    // Create only one auth file
    writeFileSync(join(protoDir, "auth-state.abc123.enc"), "encrypted-data");

    const deleted = clearAuthState(tempDir);
    expect(deleted).toBe(1);
  });

  it("ignores files with wrong prefix or suffix", () => {
    const protoDir = join(tempDir, PROTO_DIR);
    mkdirSync(protoDir, { recursive: true });

    // Create files that look like auth but aren't
    writeFileSync(join(protoDir, "auth-state-abc123.json"), "not-encrypted"); // wrong suffix
    writeFileSync(join(protoDir, "other-state.abc123.enc"), "not-auth"); // wrong prefix
    writeFileSync(join(protoDir, "auth-state.abc123"), "no-ext"); // missing .enc

    // Create a real auth file
    writeFileSync(join(protoDir, "auth-state.real.enc"), "real-data");

    const deleted = clearAuthState(tempDir);
    expect(deleted).toBe(1);
  });
});

describe("listAuthStateFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-auth-list-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when no auth files exist", () => {
    const files = listAuthStateFiles(tempDir);
    expect(files).toEqual([]);
  });

  it("returns empty array when .vibeflow directory does not exist", () => {
    const files = listAuthStateFiles(join(tempDir, "nonexistent"));
    expect(files).toEqual([]);
  });

  it("lists all auth state files with task IDs", () => {
    const protoDir = join(tempDir, PROTO_DIR);
    mkdirSync(protoDir, { recursive: true });

    writeFileSync(join(protoDir, "auth-state.abc123.enc"), "data-1");
    writeFileSync(join(protoDir, "auth-state.def456.enc"), "data-2");

    const files = listAuthStateFiles(tempDir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.taskId).sort()).toEqual(["abc123", "def456"]);
  });

  it("reports age correctly", () => {
    const protoDir = join(tempDir, PROTO_DIR);
    mkdirSync(protoDir, { recursive: true });

    writeFileSync(join(protoDir, "auth-state.test.enc"), "data");

    const files = listAuthStateFiles(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0].age).toMatch(/^\d+[mhd]$/); // e.g. "0m", "1h", "2d"
  });
});
