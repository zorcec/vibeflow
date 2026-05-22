import { execSync } from "node:child_process";

export function getGitUser(projectDir: string): { name: string; email: string } {
  try {
    const name = execSync("git config user.name", { cwd: projectDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const email = execSync("git config user.email", { cwd: projectDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { name: name || "Unknown", email: email || "" };
  } catch {
    return { name: "Unknown", email: "" };
  }
}
