import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GRANDFATHERED_COMMITS,
  collectCommits,
  identityViolations,
  isTestIdentity,
} from "../../../../scripts/check-git-identity.mjs";

const root = resolve(__dirname, "../../../..");
const script = join(root, "scripts/check-git-identity.mjs");
const zero = "0".repeat(40);
const dirs: string[] = [];
// Hook-driven suites inherit Git's index/identity env. Never let it escape into fixtures.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const realName = "Project Contributor";
const realEmail = "contributor@vibeflow.tools";

function git(cwd: string, args: string[], input?: string, overrides = {}) {
  return execFileSync("git", args, {
    cwd, input, env: { ...env, ...overrides }, encoding: "utf8", stdio: "pipe",
  }).trim();
}

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "git-identity-"));
  dirs.push(cwd);
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", realName]);
  git(cwd, ["config", "user.email", realEmail]);
  return cwd;
}

function run(cwd: string, args: string[] = [], overrides = {}, input?: string) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd, env: { ...env, ...overrides }, input, encoding: "utf8",
  });
}

// Create an object/ref, not a hook-bypassed commit. Only disposable repos use this helper.
function commitObject(cwd: string, parent?: string, overrides = {}) {
  const tree = git(cwd, ["mktree"], "");
  const sha = git(cwd, ["commit-tree", tree, ...(parent ? ["-p", parent] : [])], "fixture\n", overrides);
  git(cwd, ["update-ref", "HEAD", sha]);
  return sha;
}

function pushInput(local: string, remote = zero, ref = "main") {
  return `refs/heads/${ref} ${local} refs/heads/${ref} ${remote}\n`;
}

function expectRefusal(result: ReturnType<typeof run>, message = "refusing commit with a test identity") {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-git-identity", () => {
  it.each([
    ["Contributor", "agent@test.local"],
    ["Contributor", "agent@example.com"],
    ["Contributor", "p5@vibeflow.tools"],
    ["Contributor", "test@localhost"],
    ["P5", realEmail], ["Test", realEmail], ["test", realEmail],
    ["Contributor", "AGENT@TEST.LOCAL"],
  ])("refuses resolved test identity %s <%s> with a real non-zero exit", (name, email) => {
    const cwd = repo();
    git(cwd, ["config", "user.name", name]);
    git(cwd, ["config", "user.email", email]);
    const result = run(cwd);
    expectRefusal(result);
    expect(result.stderr).toContain(`Author: ${name} <${email}>`);
    expect(result.stderr).toContain(`Committer: ${name} <${email}>`);
    expect(result.stderr).toContain('git config user.name "Your Name"');
    expect(result.stderr).toContain('git config user.email "you@your-domain.org"');
  });

  it("accepts a real identity", () => {
    const result = run(repo());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`accepted author ${realName} <${realEmail}>; committer ${realName} <${realEmail}>.`);
    expect(result.stderr).toBe("");
  });

  it.each(["AUTHOR", "COMMITTER"])("resolves GIT_%s overrides, not just config", (role) => {
    const result = run(repo(), [], { [`GIT_${role}_EMAIL`]: "p5@test.local" });
    expectRefusal(result);
    expect(result.stderr).toContain(`${role === "AUTHOR" ? "Author" : "Committer"}: ${realName} <p5@test.local>`);
  });

  it("does not accept generic or identity-specific silent opt-outs", () => {
    const result = run(repo(), [], {
      GIT_AUTHOR_NAME: "P5", GIT_AUTHOR_EMAIL: "p5@test.local",
      HUSKY: "0", ALLOW_TEST_IDENTITY: "1",
    });
    expectRefusal(result);
  });

  it.each(["someone@sub.test.local", "someone@example.company", "p5user@vibeflow.tools"])("does not overmatch %s", (email) => {
    expect(isTestIdentity(realName, email)).toBe(false);
  });

  it("runs before other pre-commit checks and before pre-push suite escape hatches", () => {
    const preCommit = readFileSync(join(root, ".husky/pre-commit"), "utf8");
    expect(preCommit).toContain("node scripts/check-git-identity.mjs");
    expect(preCommit.indexOf("node scripts/check-git-identity.mjs")).toBeLessThan(preCommit.indexOf("export PATH="));
    const prePush = readFileSync(join(root, ".husky/pre-push"), "utf8");
    expect(prePush).toContain('--pre-push "${1:-origin}"');
    expect(prePush.indexOf('--pre-push "${1:-origin}"')).toBeLessThan(prePush.indexOf('if [ "${VIBEFLOW_SKIP_PREPUSH'));
  });

  it("keeps exactly five resolvable incident exceptions, each with the known author email", () => {
    expect(GRANDFATHERED_COMMITS).toHaveLength(5);
    expect(new Set(GRANDFATHERED_COMMITS).size).toBe(5);
    for (const sha of GRANDFATHERED_COMMITS) {
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
      const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, env });
      expect(result.status, `grandfather entry no longer resolvable; remove it or restore the reference: ${sha}`).toBe(0);
      expect(git(root, ["log", "-1", "--format=%ae", sha])).toBe("p5@test.local");
    }
  });

  it("checks the last 50 real commits in the normal unit suite", () => {
    const result = run(root, ["--history"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no new test identities in checked commits");
  });

  it("filters only exact grandfather SHAs through the shared scan predicate", () => {
    const bad = { authorName: "P5", authorEmail: "p5@test.local", committerName: "P5", committerEmail: "p5@test.local" };
    const newSha = "a".repeat(40);
    expect(identityViolations([
      { ...bad, sha: GRANDFATHERED_COMMITS[0] }, { ...bad, sha: newSha },
    ])).toEqual([{ ...bad, sha: newSha }]);
  });

  it("reports exactly one new offender alongside grandfathered history in both scan modes", () => {
    const cwd = repo();
    // Isolate the original incident object; its full SHA is not fabricated.
    git(cwd, ["fetch", "-q", "--depth=1", root, GRANDFATHERED_COMMITS[0]]);
    const bad = commitObject(cwd, GRANDFATHERED_COMMITS[0], { GIT_AUTHOR_NAME: "P5", GIT_AUTHOR_EMAIL: "p5@test.local" });
    for (const result of [run(cwd, ["--history"]), run(cwd, ["--pre-push"], {}, pushInput(bad))]) {
      expectRefusal(result, "refusing 1 commit(s) with a test identity");
      expect(result.stderr).toContain(`Commit: ${bad}`);
      expect(result.stderr.match(/  Commit: /g)).toHaveLength(1);
      expect(result.stderr).not.toContain(`Commit: ${GRANDFATHERED_COMMITS[0]}`);
    }
    expect(identityViolations(collectCommits(["-n", "50", "HEAD"], cwd))).toHaveLength(1);
  });

  it("checks author AND committer on each outgoing ref, excluding the remote baseline", () => {
    const cwd = repo();
    const baseline = commitObject(cwd, undefined, { GIT_AUTHOR_EMAIL: "p5@test.local" });
    const good = commitObject(cwd, baseline);
    const authorBad = commitObject(cwd, good, { GIT_AUTHOR_EMAIL: "p5@test.local" });
    const committerBad = commitObject(cwd, good, { GIT_COMMITTER_EMAIL: "test@localhost" });
    const result = run(cwd, ["--pre-push"], {}, pushInput(authorBad, baseline) + pushInput(committerBad, baseline, "other"));
    expectRefusal(result, "refusing 2 commit(s) with a test identity");
    expect(result.stderr).toContain(`Commit: ${authorBad}`);
    expect(result.stderr).toContain(`Commit: ${committerBad}`);
    expect(result.stderr).not.toContain(`Commit: ${baseline}`);
    expect(run(cwd, ["--pre-push"], {}, pushInput(good, baseline)).status).toBe(0);
  });

  it("excludes existing remote commits for new refs, but checks new ancestors", () => {
    const cwd = repo();
    const baseline = commitObject(cwd, undefined, { GIT_AUTHOR_EMAIL: "p5@test.local" });
    git(cwd, ["update-ref", "refs/remotes/origin/main", baseline]);
    const good = commitObject(cwd, baseline);
    expect(run(cwd, ["--pre-push"], {}, pushInput(good)).status).toBe(0);
    const bad = commitObject(cwd, good, { GIT_COMMITTER_NAME: "Test" });
    const result = run(cwd, ["--pre-push"], {}, pushInput(bad));
    expectRefusal(result, "refusing 1 commit(s) with a test identity");
    expect(result.stderr).toContain(`Commit: ${bad}`);
  });

  it("scans full local history when the remote SHA is unavailable", () => {
    const cwd = repo();
    const bad = commitObject(cwd, undefined, { GIT_AUTHOR_EMAIL: "p5@test.local" });
    const good = commitObject(cwd, bad);
    const result = run(cwd, ["--pre-push"], {}, pushInput(good, "f".repeat(40)));
    expectRefusal(result, "refusing 1 commit(s) with a test identity");
    expect(result.stderr).toContain("checking full local history");
    expect(result.stderr).toContain(`Commit: ${bad}`);
  });

  it("accepts deleted refs and rejects malformed ref updates", () => {
    const cwd = repo();
    expect(run(cwd, ["--pre-push"], {}, pushInput(zero, "f".repeat(40))).status).toBe(0);
    const result = run(cwd, ["--pre-push"], {}, "malformed\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid pre-push ref update");
  });
});
