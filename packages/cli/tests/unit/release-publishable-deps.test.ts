import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Release gate — only the CLI is publishable; the other packages are `private`
 * and reachable through `file:`/`workspace:` links. The gate exists so a
 * release run stops before npm sees a tarball whose dependency is a local path.
 */
const root = resolve(__dirname, "../../../..");

describe("publishable dependencies", () => {
  it("passes on the real tree", () => {
    const out = execFileSync("node", [join(root, "scripts/check-publishable-deps.mjs")], {
      cwd: root,
      encoding: "utf-8",
    });
    expect(out).toContain("no local file: links");
  });

  it("only the CLI is publishable, and its workspace deps are rewritten on publish", () => {
    const cli = JSON.parse(
      readFileSync(join(root, "packages/cli/package.json"), "utf-8"),
    );
    expect(cli.private).not.toBe(true);
    for (const pkg of ["ui", "shared", "api-core"]) {
      const manifest = JSON.parse(
        readFileSync(join(root, "packages", pkg, "package.json"), "utf-8"),
      );
      expect(manifest.private, `${pkg} must stay private`).toBe(true);
    }
    // All workspace packages are devDependencies: tsup bundles them into dist,
    // so the published tarball carries no runtime link at all. A `file:` or a
    // runtime dependency here would ship an unresolvable path to every user.
    expect(cli.dependencies ?? {}).not.toHaveProperty("@vibeflow-tools/shared");
    for (const dep of Object.keys(cli.devDependencies ?? {})) {
      if (!dep.startsWith("@vibeflow-tools/")) continue;
      expect(
        cli.devDependencies[dep],
        `${dep} must stay on the workspace protocol`,
      ).toMatch(/^workspace:/);
    }
  });
});
