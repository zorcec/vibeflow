import chalk from "chalk";
import { deleteToken } from "./token.js";
import { deleteWorkspace } from "./workspace.js";

export async function logout(): Promise<void> {
  await Promise.all([deleteToken(), deleteWorkspace()]);
  console.log(chalk.green("  Logged out. Now operating in local mode."));
}
