/**
 * tsup chunk-sync regression — ticket afd745a3.
 *
 * `dist/index.js` is the shipped entry (package.json "bin"). It is a copy of
 * `dist/cli/index.js` and loads its code-split chunks through RELATIVE imports
 * (`./chunk-XXXX.js`, `./verify-attestation-XXXX.js`, ...). tsup's onSuccess
 * hook copies those chunks from `dist/cli/` into `dist/`.
 *
 * That copy step used to be a hand-maintained regex allowlist. When
 * `verify-attestation` was added as a dynamic import (be35afc) the allowlist was
 * not extended, so the chunk was emitted but never synced. The build succeeded
 * and the unit suite (which imports from `src/`) stayed green — while every
 * `vibeflow tasks --edit` crashed at runtime with ERR_MODULE_NOT_FOUND.
 *
 * These tests inspect the BUILT output, so they fail if a future dynamic import
 * is emitted without being synced into `dist/`. Build first:
 *   pnpm --filter @vibeflow-tools/cli run build
 *
 * The graph is NOT walked transitively: some chunks embed client bundles as
 * string literals (e.g. `import('./MyComponent')` inside a template), which a
 * regex would misread as real imports. The entry itself is CLI code and carries
 * no such embedded bundle, so parsing it directly is exact. Because the sync now
 * copies EVERY emitted module, the entry's imports plus the emitted-file set
 * together cover the whole runtime graph.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DIST_DIR = resolve(process.cwd(), "dist");
const CLI_DIR = join(DIST_DIR, "cli");
const ENTRY = join(DIST_DIR, "index.js");

/** Relative (`./…`) specifiers. `dynamicOnly` restricts to `import("…")`. */
function relativeSpecifiers(source: string, dynamicOnly = false): string[] {
  const pattern = dynamicOnly
    ? /import\s*\(\s*["'](\.\/[^"']+)["']\s*\)/g
    : /(?:import|from)\s*\(?\s*["'](\.\/[^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function missingOnDisk(specifiers: string[]): string[] {
  return specifiers.filter((s) => !existsSync(resolve(DIST_DIR, s)));
}

describe("tsup chunk-sync (dist)", () => {
  it("the packaged entry exists (build the CLI first)", () => {
    expect(
      existsSync(ENTRY),
      `missing ${ENTRY} — run: pnpm --filter @vibeflow-tools/cli run build`,
    ).toBe(true);
  });

  it("every chunk referenced by a dynamic import in dist exists on disk", () => {
    expect(existsSync(ENTRY)).toBe(true);
    const dynamic = relativeSpecifiers(readFileSync(ENTRY, "utf-8"), true);
    expect(dynamic.length).toBeGreaterThan(0);
    expect(missingOnDisk(dynamic), "dynamic imports not synced into dist/").toEqual(
      [],
    );
  });

  it("every relative import in the packaged entry resolves on disk", () => {
    expect(existsSync(ENTRY)).toBe(true);
    const specifiers = relativeSpecifiers(readFileSync(ENTRY, "utf-8"));
    expect(specifiers.length).toBeGreaterThan(0);
    expect(missingOnDisk(specifiers), "imports not synced into dist/").toEqual(
      [],
    );
  });

  it("every emitted dist/cli module is synced into dist (no allowlist drift)", () => {
    const emitted = readdirSync(CLI_DIR).filter(
      (name) => name.endsWith(".js") && name !== "index.js",
    );
    expect(emitted.length).toBeGreaterThan(0);
    const unsynced = emitted.filter((name) => !existsSync(join(DIST_DIR, name)));
    expect(
      unsynced,
      `dist/cli modules not copied into dist/:\n${unsynced.join("\n")}`,
    ).toEqual([]);
  });

  it("the verify-attestation chunk — the one the allowlist omitted — is synced", () => {
    // Concrete regression for afd745a3: without this chunk every `tasks --edit`
    // dies with ERR_MODULE_NOT_FOUND.
    const attestation = relativeSpecifiers(
      readFileSync(ENTRY, "utf-8"),
      true,
    ).filter((s) => s.includes("verify-attestation"));
    expect(attestation.length).toBeGreaterThan(0);
    for (const specifier of attestation) {
      expect(existsSync(join(DIST_DIR, specifier)), `missing ${specifier}`).toBe(
        true,
      );
    }
  });
});
