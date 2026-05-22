import { describe, it, expect, vi, afterEach } from "vitest";

// Mock node:fs/promises before importing so WORKSPACE_PATH constants don't matter.
vi.mock("node:fs/promises");

import fs from "node:fs/promises";
import { readWorkspace, writeWorkspace, deleteWorkspace } from "../../../src/auth/workspace.js";

afterEach(() => vi.clearAllMocks());

const SAMPLE_WORKSPACE = { id: "ws-1", name: "My Board", url: "http://localhost:3000" };

describe("readWorkspace", () => {
  it("returns parsed workspace when file exists", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(SAMPLE_WORKSPACE) as never);
    const result = await readWorkspace();
    expect(result).toEqual(SAMPLE_WORKSPACE);
  });

  it("returns null when file does not exist", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await readWorkspace();
    expect(result).toBeNull();
  });

  it("returns null when file has invalid JSON", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("not-json" as never);
    const result = await readWorkspace();
    expect(result).toBeNull();
  });
});

describe("writeWorkspace", () => {
  it("creates .vibeflow directory and writes workspace JSON with mode 0o600", async () => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await writeWorkspace(SAMPLE_WORKSPACE);

    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining(".vibeflow"), { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("workspace"),
      JSON.stringify(SAMPLE_WORKSPACE, null, 2),
      { mode: 0o600 },
    );
  });
});

describe("deleteWorkspace", () => {
  it("removes the workspace file", async () => {
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    await deleteWorkspace();
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining("workspace"));
  });

  it("does not throw when file does not exist", async () => {
    vi.mocked(fs.unlink).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await expect(deleteWorkspace()).resolves.toBeUndefined();
  });
});
