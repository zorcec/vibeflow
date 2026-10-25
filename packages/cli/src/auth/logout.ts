import chalk from "chalk";
import { resolve } from "node:path";
import { deleteCredential } from "./credentials.js";
import { deleteProjectPointer, readProjectPointer } from "./project-pointer.js";

/**
 * Project-scoped logout (ADR-0005): removes ONLY the credential for the
 * current project's linked apiUrl. Other projects' entries in the shared
 * store are untouched. The repo pointer stays by default (the project is
 * still "linked", just without a credential — mode resolves local with a
 * notice); pass `--unlink` to remove the pointer too.
 */
export async function logout(
  projectDir?: string,
  opts?: { unlink?: boolean },
): Promise<void> {
  const dir = resolve(projectDir ?? ".");
  const pointer = readProjectPointer(dir);
  if (!pointer) {
    console.log(
      chalk.yellow("  This project is not linked to a board — nothing to log out."),
    );
    console.log(
      chalk.dim("  Run `vibeflow login` in this project to link it."),
    );
    return;
  }
  await deleteCredential(pointer.apiUrl);
  if (opts?.unlink === true) deleteProjectPointer(dir);
  console.log(chalk.green("  Logged out. Now operating in local mode."));
}
