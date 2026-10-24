#!/usr/bin/env node
/**
 * Release gate: refuse to publish a package whose dependencies are local links.
 *
 * `@vibeflow-tools/ui` depends on `@vibeflow-tools/shared` via `file:../shared`
 * on purpose — the public packages are consumed through the private repo's
 * workspace, which links them by path, and the Docker build copies both trees
 * into one context. A `workspace:` range there breaks the image build outright
 * (the public packages are not workspace members in that context).
 *
 * The cost of that choice: `file:` dependencies survive as-is into a published
 * tarball, so anyone installing the package would get an unresolvable path.
 * Publishing the CLI is unaffected (it depends on shared through the workspace
 * protocol, which pnpm rewrites on publish).
 *
 * This gate makes the trade explicit instead of silent: it lists what cannot
 * be published today and exits non-zero so a release run stops BEFORE npm sees
 * a broken tarball.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const packagesDir = join(root, "packages");
const broken = [];

for (const name of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, name, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (manifest.private) continue;
  const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
  const local = Object.entries(deps).filter(
    ([, range]) => typeof range === "string" && range.startsWith("file:"),
  );
  if (local.length > 0) {
    broken.push({
      name: manifest.name,
      version: manifest.version,
      local: local.map(([dep, range]) => `${dep}@${range}`),
    });
  }
}

if (broken.length > 0) {
  console.error("✗ These packages cannot be published — they carry local file: links:\n");
  for (const pkg of broken) {
    console.error(`  ${pkg.name}@${pkg.version}: ${pkg.local.join(", ")}`);
  }
  console.error(
    "\n  Publishing them would ship an unresolvable path to every consumer.",
  );
  console.error(
    "  Either publish the dependency first and pin a real semver range here,",
  );
  console.error(
    "  or keep the package out of the release (remove its changesets).",
  );
  process.exit(1);
}

console.log("✓ publishable dependencies: no local file: links in reachable packages");
