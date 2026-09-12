import { execSync } from "node:child_process";
import { gitEnvWithCleanLocation } from "./git-env.js";

export function getGitUser(projectDir: string): { name: string; email: string } {
  try {
    // Resolve identity from `projectDir` (the task-store repo), never from a
    // GIT_DIR/GIT_WORK_TREE leaked by an enclosing git hook.
    const env = gitEnvWithCleanLocation();
    const name = execSync("git config user.name", { cwd: projectDir, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const email = execSync("git config user.email", { cwd: projectDir, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { name: name || "Unknown", email: email || "" };
  } catch {
    return { name: "Unknown", email: "" };
  }
}
