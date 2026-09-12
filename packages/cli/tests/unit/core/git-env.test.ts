import { describe, it, expect } from "vitest";
import { gitEnvWithCleanLocation } from "../../../src/core/git-env.js";

describe("gitEnvWithCleanLocation", () => {
  it("strips git repo-location variables so git resolves the repo from cwd", () => {
    const env = gitEnvWithCleanLocation({
      PATH: "/usr/bin",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/elsewhere/.git/index",
      GIT_OBJECT_DIRECTORY: "/objects",
      GIT_COMMON_DIR: "/common",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/alt",
      GIT_PREFIX: "sub/",
      HOME: "/home/tester",
    });

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/tester" });
  });

  it("does not mutate the base environment object", () => {
    const base = { GIT_DIR: "/elsewhere/.git", KEEP: "1" };
    gitEnvWithCleanLocation(base);
    expect(base).toEqual({ GIT_DIR: "/elsewhere/.git", KEEP: "1" });
  });
});
