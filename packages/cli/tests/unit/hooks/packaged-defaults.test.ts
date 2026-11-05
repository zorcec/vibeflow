/**
 * Packaged-defaults layout matrix (ADR-0007, T3): the shipped root is
 * DERIVED from the running bundle, never configured — npm nested, pnpm
 * symlink-into-store, npx cache, and workspace/src layouts must all
 * resolve, and a missing VERSION must refuse loudly.
 *
 * Failure markers: point the probe at `$HOME` and the pnpm case fails;
 * drop the `dist/hooks/` files entry and the tarball test (T6) fails.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolveShippedDefaultsDir } from "../../../src/core/hooks/discover.js";
import { resolveHookFile } from "../../../src/core/hooks/discover.js";

const HERE = dirname(new URL(import.meta.url).pathname);
// tests/unit/hooks/ → packages/cli/src/core/hooks/defaults
const SRC_DEFAULTS = join(HERE, "..", "..", "..", "src", "core", "hooks", "defaults");

function runHook(file: string, envelope: unknown): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      process.execPath,
      [file],
      { timeout: 10000 },
      (err, stdout) => (err ? reject(err) : resolvePromise(JSON.parse(stdout.trim()))),
    );
    child.stdin?.write(JSON.stringify(envelope) + "\n");
    child.stdin?.end();
  });
}

/** A fake installed layout: bundle file + defaults tree copied from src. */
function fakeInstall(structure: (root: string) => { bundle: string; defaults: string }): {
  bundleUrl: URL;
  defaults: string;
} {
  const root = mkdtempSync(join(tmpdir(), "hook-pkg-layout-"));
  const { bundle, defaults } = structure(root);
  mkdirSync(dirname(bundle), { recursive: true });
  writeFileSync(bundle, `// fake bundle\n`);
  mkdirSync(defaults, { recursive: true });
  cpSync(SRC_DEFAULTS, defaults, { recursive: true });
  return { bundleUrl: pathToFileURL(bundle), defaults };
}

describe("resolveShippedDefaultsDir layout matrix", () => {
  it("(a) npm nested install layout", async () => {
    const { bundleUrl, defaults } = fakeInstall((root) => ({
      bundle: join(root, "node_modules", "@vibeflow-tools", "cli", "dist", "bundle.mjs"),
      defaults: join(root, "node_modules", "@vibeflow-tools", "cli", "dist", "hooks", "defaults"),
    }));
    const { realpathSync } = await import("node:fs");
    expect(resolveShippedDefaultsDir({ bundleUrl })).toBe(realpathSync(defaults));
    const out = (await runHook(join(defaults, "tasks.after.mjs"), {
      activity: "task.update",
    })) as { instructions?: string };
    expect(typeof out.instructions).toBe("string");
    expect(out.instructions).toContain('NEVER set a task status to "done"');
  });

  it("(b) pnpm symlink-into-store layout", async () => {
    const store = mkdtempSync(join(tmpdir(), "hook-pnpm-store-"));
    const storePkg = join(store, "node_modules", "@vibeflow-tools", "cli");
    const storeDist = join(storePkg, "dist");
    mkdirSync(storeDist, { recursive: true });
    const bundle = join(storeDist, "bundle.mjs");
    writeFileSync(bundle, `// fake bundle\n`);
    const defaults = join(storeDist, "hooks", "defaults");
    mkdirSync(defaults, { recursive: true });
    cpSync(SRC_DEFAULTS, defaults, { recursive: true });
    // The consumer side: node_modules/@vibeflow-tools/cli symlinks into the store.
    const root = mkdtempSync(join(tmpdir(), "hook-pnpm-root-"));
    const linkDir = join(root, "node_modules", "@vibeflow-tools");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(storePkg, join(linkDir, "cli"));
    const { realpathSync } = await import("node:fs");
    const viaLink = pathToFileURL(join(linkDir, "cli", "dist", "bundle.mjs"));
    expect(resolveShippedDefaultsDir({ bundleUrl: viaLink })).toBe(realpathSync(defaults));
    // The linked file resolves through the SAME root: containment holds.
    const resolved = resolveHookFile(root, "tasks", "after", {
      shippedDir: resolveShippedDefaultsDir({ bundleUrl: viaLink }),
    });
    expect(resolved !== null && !("conflict" in resolved) && resolved.file).toBe(
      join(realpathSync(defaults), "tasks.after.mjs"),
    );
  });

  it("(c) npx cache layout", async () => {
    const { bundleUrl } = fakeInstall((root) => ({
      bundle: join(root, "_npx", "abc123", "node_modules", "@vibeflow-tools", "cli", "dist", "bundle.mjs"),
      defaults: join(
        root,
        "_npx",
        "abc123",
        "node_modules",
        "@vibeflow-tools",
        "cli",
        "dist",
        "hooks",
        "defaults",
      ),
    }));
    expect(resolveShippedDefaultsDir({ bundleUrl })).not.toBeNull();
  });

  it("(d) workspace source-tree layout", () => {
    // The running "bundle" is the source tree itself (unit tests import
    // src directly): probe from discover.ts, not from this test file.
    const discoverUrl = pathToFileURL(join(SRC_DEFAULTS, "..", "discover.ts"));
    const root = resolveShippedDefaultsDir({ bundleUrl: discoverUrl });
    expect(root).not.toBeNull();
    // The probe lands on the committed source tree itself.
    expect(readFileSync(join(root as string, "VERSION"), "utf8").trim()).toBe("2");
  });

  it("no VERSION ⇒ null (the caller prints HOOK_SHIPPED_DEFAULTS_MISSING, no default hook)", async () => {
    const root = mkdtempSync(join(tmpdir(), "hook-pkg-noversion-"));
    const bundle = join(root, "dist", "bundle.mjs");
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, `// fake bundle\n`);
    mkdirSync(join(root, "dist", "hooks", "defaults"), { recursive: true });
    expect(
      resolveShippedDefaultsDir({ bundleUrl: pathToFileURL(bundle) }),
    ).toBeNull();
  });

  it("a stale ~/.vibeflow/hooks/defaults copy is NEVER read", async () => {
    // The v1 materialisation path: home carries an old copy with marker
    // text. The shipped root wins by construction — the old text must not
    // appear in any resolved run.
    const home = mkdtempSync(join(tmpdir(), "hook-pkg-home-"));
    const staleDir = join(home, ".vibeflow", "hooks", "defaults", "after");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(
      join(staleDir, "after-task.update.mjs"),
      `process.stdout.write(JSON.stringify({instructions:"STALE-MATERIALISED-COPY"})+"\\n");\n`,
    );
    const projectDir = mkdtempSync(join(tmpdir(), "hook-pkg-proj-"));
    const { bundleUrl } = fakeInstall((root) => ({
      bundle: join(root, "dist", "bundle.mjs"),
      defaults: join(root, "dist", "hooks", "defaults"),
    }));
    const { realpathSync } = await import("node:fs");
    const shipped = resolveShippedDefaultsDir({ bundleUrl }) as string;
    const resolved = resolveHookFile(projectDir, "tasks", "after", { home, shippedDir: shipped });
    expect(resolved !== null && !("conflict" in resolved)).toBe(true);
    if (resolved === null || "conflict" in resolved) throw new Error("expected a hook");
    expect(resolved.file).toBe(join(realpathSync(shipped), "tasks.after.mjs"));
    const out = (await runHook(resolved.file, { activity: "task.update" })) as {
      instructions?: string;
    };
    expect(out.instructions).not.toContain("STALE-MATERIALISED-COPY");
  });
});
