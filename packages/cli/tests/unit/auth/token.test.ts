import { describe, it, expect, vi, afterEach } from "vitest";

// Mock node:fs/promises before importing the module under test so that
// TOKEN_PATH (set at module-load time) is irrelevant — we intercept all FS calls.
vi.mock("node:fs/promises");

import fs from "node:fs/promises";
import { readToken, writeToken, deleteToken, getTokenPath } from "../../../src/auth/token.js";

afterEach(() => vi.clearAllMocks());

describe("readToken", () => {
  it("returns trimmed token on success", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("my-token\n" as never);
    expect(await readToken()).toBe("my-token");
  });

  it("returns null when content is empty/whitespace-only", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("  " as never);
    expect(await readToken()).toBeNull();
  });

  it("returns null when file does not exist", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    expect(await readToken()).toBeNull();
  });
});

describe("writeToken", () => {
  it("creates the .vibeflow directory and writes the token with mode 0o600", async () => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await writeToken("secret-token");

    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining(".vibeflow"), { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("token"),
      "secret-token",
      { mode: 0o600 },
    );
  });
});

describe("deleteToken", () => {
  it("removes the token file", async () => {
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    await deleteToken();
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("token"));
  });

  it("does not throw when file does not exist (idempotent)", async () => {
    vi.mocked(fs.unlink).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await expect(deleteToken()).resolves.toBeUndefined();
  });
});

describe("getTokenPath", () => {
  it("returns a path ending in .vibeflow/token", () => {
    expect(getTokenPath()).toMatch(/\.vibeflow[\/\\]token$/);
  });
});
