import chalk from "chalk";
import { resolve } from "node:path";
import { deleteCredential } from "./credentials.js";
import { deleteProjectPointer, readProjectPointer } from "./project-pointer.js";

/**
 * Project-scoped logout (ADR-0005): removes ONLY the credential for the
 * current project's linked apiUrl. Other projects' entries in the shared
 * store are untouched. The repo pointer stays by default — and a pointer
 * without a credential is the state every task command REFUSES (NOT_CONNECTED,
 * never silent local), so the message says so instead of claiming local mode;
 * pass `--unlink` to remove the pointer too and really work locally.
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
  if (opts?.unlink === true) {
    deleteProjectPointer(dir);
    console.log(chalk.green("  Logged out. Now operating in local mode."));
    return;
  }
  // The pointer remains, so this project now names a board it cannot
  // authenticate to: task commands refuse instead of silently writing
  // locally. Saying "now operating in local mode" here was the same lie as
  // the silent online write (ticket 73cb9048).
  console.log(chalk.green("  Logged out — the credential is gone."));
  console.log(
    chalk.yellow(
      `  This project is still linked to board ${pointer.id}, so task commands will refuse until you re-link.`,
    ),
  );
  console.log(
    chalk.dim(
      "  Run `vibeflow login` in this project to link it again, or `vibeflow auth logout --unlink` to work locally.",
    ),
  );
}
