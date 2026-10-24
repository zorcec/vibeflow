import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Release gate — after `npm publish` lands, `pnpm release:cli` creates the
 * annotated tag and the GitHub release (there is no CI to do it — ADR-0007).
 * The script must refuse a version with no CHANGELOG section instead of
 * publishing unreadable empty notes, and re-running it on an already-released
 * version must exit 0 ("already released") instead of erroring.
 */
const root = resolve(__dirname, "../../../..");
const script = join(root, "scripts/release-cli.mjs");

function printNotes(version: string): string {
  return execFileSync("node", [script, "--print-notes", "--version", version], {
    cwd: root,
    encoding: "utf-8",
  });
}

describe("release-cli", () => {
  it("is wired as pnpm release:cli", () => {
    expect(existsSync(script)).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["release:cli"]).toContain("scripts/release-cli.mjs");
  });

  it("prints the published version's section with its heading", () => {
    const cli = JSON.parse(
      readFileSync(join(root, "packages/cli/package.json"), "utf-8"),
    ) as { version: string };
    expect(printNotes(cli.version)).toContain(`## ${cli.version}`);
  });

  it("refuses a version with no changelog section, naming the version", () => {
    let stderr = "";
    try {
      printNotes("9.9.9");
    } catch (err) {
      stderr = String(
        (err as { stderr?: unknown })?.stderr ?? (err as Error)?.message ?? err,
      );
    }
    expect(stderr).toContain("9.9.9");
  });
});
