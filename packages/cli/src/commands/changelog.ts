import chalk from "chalk";
import { changelogText, readChangelogContent } from "../core/changelog.js";

/**
 * `vibeflow changelog` — prints the CLI changelog to the terminal.
 * Latest version section by default; `--all` prints every version.
 */
export function showChangelog(opts: { all?: boolean } = {}): void {
  const text = changelogText(readChangelogContent() ?? "", opts);
  if (!text) {
    console.log(chalk.dim("  No changelog found for this installation."));
    return;
  }
  console.log();
  console.log(text);
  console.log();
  if (!opts.all) {
    console.log(
      chalk.dim("  Run ") +
        chalk.cyan("vibeflow changelog --all") +
        chalk.dim(" to see every release."),
    );
    console.log();
  }
}
