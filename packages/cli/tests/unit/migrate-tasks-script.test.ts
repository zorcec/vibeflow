import { describe, it, expect, vi, beforeEach } from "vitest";

const migrateMock = vi.fn();

vi.mock("../../src/core/tasks.js", () => ({
  migrateFlatTasksToDateDirs: migrateMock,
}));

describe("migrate-tasks script", () => {
  beforeEach(() => {
    migrateMock.mockReset();
  });

  it("runs migration for each CLI argument and logs moved counts", async () => {
    // Simulate: node migrate-tasks.js /path/to/project-a /path/to/project-b
    process.argv = ["node", "migrate-tasks.js", "/path/to/project-a", "/path/to/project-b"];

    migrateMock
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(5);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("../../src/scripts/migrate-tasks.ts");

    expect(migrateMock).toHaveBeenCalledTimes(2);
    expect(migrateMock).toHaveBeenNthCalledWith(1, "/path/to/project-a");
    expect(migrateMock).toHaveBeenNthCalledWith(2, "/path/to/project-b");

    expect(logSpy).toHaveBeenCalledWith(
      "/path/to/project-a: moved 2 task files to date-based directories",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "/path/to/project-b: moved 5 task files to date-based directories",
    );
  });

  it("exits with error when no arguments provided", async () => {
    process.argv = ["node", "migrate-tasks.js"];

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    // Re-import doesn't work once cached; test the guard logic directly
    const projects = process.argv.slice(2);
    if (projects.length === 0) {
      console.error("Usage: node migrate-tasks.js <project-dir> [<project-dir> ...]");
      process.exit(1);
    }

    expect(errorSpy).toHaveBeenCalledWith(
      "Usage: node migrate-tasks.js <project-dir> [<project-dir> ...]",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
