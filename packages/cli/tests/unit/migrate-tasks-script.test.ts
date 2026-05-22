import { describe, it, expect, vi, beforeEach } from "vitest";

const migrateMock = vi.fn();

vi.mock("../../src/core/tasks.js", () => ({
  migrateFlatTasksToDateDirs: migrateMock,
}));

describe("migrate-tasks script", () => {
  beforeEach(() => {
    migrateMock.mockReset();
  });

  it("runs migration for all hardcoded projects and logs moved counts", async () => {
    migrateMock
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(5);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await import("../../src/scripts/migrate-tasks.ts");

    expect(migrateMock).toHaveBeenCalledTimes(2);
    expect(migrateMock).toHaveBeenNthCalledWith(1, "/path/to/project");
    expect(migrateMock).toHaveBeenNthCalledWith(2, "/path/to/another-project");

    expect(logSpy).toHaveBeenCalledWith(
      "/path/to/project: moved 2 task files to date-based directories",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "/path/to/another-project: moved 5 task files to date-based directories",
    );
  });
});
