import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock the tasks module
vi.mock("../../../src/core/tasks.js", () => ({
  findTaskFilePath: vi.fn().mockReturnValue("/fake/task.json"),
  readTaskFile: vi.fn().mockReturnValue({ id: "test-task-123", description: "test" }),
}));

// Mock the files module
vi.mock("../../../src/core/files.js", () => ({
  getFilesDir: vi.fn().mockImplementation((_dir: string, taskId: string) => `/fake/files/${taskId}`),
}));

import { readEvidence, runVerifyTool } from "../../../src/commands/verify-tools.js";

describe("verify-tools e2e", () => {
  it("routing regression: runVerifyTool dispatches correctly", async () => {
    // Mock process.stderr.write to capture error messages
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    
    // Test missing task ID
    await runVerifyTool(".", "style_query", []);
    expect(stderrWrite).toHaveBeenCalled();
    
    stderrWrite.mockRestore();
  });
});
