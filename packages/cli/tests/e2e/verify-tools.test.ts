/**
 * verify-tools e2e — routing regression: runVerifyTool dispatches correctly.
 *
 * Modules are mocked so the routing layer is exercised without Playwright.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/core/tasks.js", () => ({
  findTaskFilePath: vi.fn().mockReturnValue("/fake/task.json"),
  readTaskFile: vi
    .fn()
    .mockReturnValue({ id: "test-task-123", description: "test" }),
}));

vi.mock("../../src/core/files.js", () => ({
  getFilesDir: vi
    .fn()
    .mockImplementation(
      (_dir: string, taskId: string) => `/fake/files/${taskId}`,
    ),
}));

import { runVerifyTool } from "../../src/commands/verify-tools.js";

describe("verify-tools e2e", () => {
  it("routing regression: runVerifyTool dispatches correctly", async () => {
    // Mock process.stderr.write to capture error messages
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    // Test missing task ID
    await runVerifyTool(".", "style_query", []);
    expect(stderrWrite).toHaveBeenCalled();

    stderrWrite.mockRestore();
  });
});
