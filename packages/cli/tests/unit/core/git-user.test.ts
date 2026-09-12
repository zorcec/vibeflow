import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { getGitUser } from "../../../src/core/git-user.js";
import { gitEnvWithCleanLocation } from "../../../src/core/git-env.js";

function initRepo(dir: string, name: string, email: string): void {
  execSync(
    `git init && git config user.name '${name}' && git config user.email '${email}'`,
    { cwd: dir, env: gitEnvWithCleanLocation(), stdio: "ignore" },
  );
}

describe("getGitUser", () => {
  let repoA: string;
  let repoB: string;

  beforeAll(() => {
    repoA = mkdtempSync(join(tmpdir(), "gituser-a-"));
    repoB = mkdtempSync(join(tmpdir(), "gituser-b-"));
    initRepo(repoA, "Alice Stone", "alice@example.com");
    initRepo(repoB, "Bob Villa", "bob@example.com");
  });

  afterAll(() => {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  });

  it("resolves identity from projectDir, not the process cwd", () => {
    // The test process cwd is inside a different repo (the CLI checkout);
    // identity must come from the directory handed in.
    expect(getGitUser(repoB)).toEqual({
      name: "Bob Villa",
      email: "bob@example.com",
    });
    expect(getGitUser(repoA)).toEqual({
      name: "Alice Stone",
      email: "alice@example.com",
    });
  });
});
