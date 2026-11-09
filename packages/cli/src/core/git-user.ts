import { execSync } from "node:child_process";
import { gitEnvWithCleanLocation } from "./git-env.js";

// Process-lifetime memo (speed ticket 77b18431): resolving identity spawns
// TWO `git config` subprocesses (~5-15 ms each), and hot paths call this per
// operation — every addComment, every attributed task create/update — so a
// 200-comment test burned ~400 spawns (~4-6 s of its wall). Identity changes
// only via an explicit `git config` outside the process: short-lived CLI
// invocations never observe a change, and the MCP server already pins
// identity once at startup (src/mcp/server.ts) — same semantics. Keyed by
// projectDir so distinct checkouts never share; tests use fresh temp dirs
// per case, so no reset seam is needed (add one if a test ever mutates git
// config mid-process in a single dir and re-reads identity).
const memo = new Map<string, { name: string; email: string }>();

export function getGitUser(projectDir: string): {
  name: string;
  email: string;
} {
  const hit = memo.get(projectDir);
  if (hit) return hit;
  let result: { name: string; email: string };
  try {
    // Resolve identity from `projectDir` (the task-store repo), never from a
    // GIT_DIR/GIT_WORK_TREE leaked by an enclosing git hook.
    const env = gitEnvWithCleanLocation();
    const name = execSync("git config user.name", {
      cwd: projectDir,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const email = execSync("git config user.email", {
      cwd: projectDir,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    result = { name: name || "Unknown", email: email || "" };
  } catch {
    result = { name: "Unknown", email: "" };
  }
  memo.set(projectDir, result);
  return result;
}
