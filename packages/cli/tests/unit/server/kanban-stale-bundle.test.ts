/**
 * Unit coverage for the stale-inlined-bundle detection in
 * `src/server/kanban-template.ts`. The kanban client bundle is inlined into
 * the served HTML at PROCESS START, so a board process whose dist was rebuilt
 * afterwards serves stale JS forever. The board records the bundle's mtime at
 * load and must emit exactly ONE warning line when a rebuild lands — this
 * suite pins the comparison and the once-only warning.
 */
import { describe, it, expect, vi } from "vitest";
import {
  isBundleStale,
  warnIfBundleStale,
  STALE_BUNDLE_WARNING,
} from "../../../src/server/kanban-template.js";
import type { BundleFileMtime } from "../../../src/server/kanban-template.js";

const BUNDLE = "/repo/src/server/kanban-bundle.gen.ts";

describe("isBundleStale", () => {
  it("is fresh when the disk mtime equals the mtime recorded at load", () => {
    const inlined: BundleFileMtime[] = [{ path: BUNDLE, mtimeMs: 1_000 }];
    const disk: BundleFileMtime[] = [{ path: BUNDLE, mtimeMs: 1_000 }];
    expect(isBundleStale(inlined, disk)).toBe(false);
  });

  it("is fresh when the disk file is older than the inlined copy", () => {
    const inlined: BundleFileMtime[] = [{ path: BUNDLE, mtimeMs: 1_000 }];
    const disk: BundleFileMtime[] = [{ path: BUNDLE, mtimeMs: 999 }];
    expect(isBundleStale(inlined, disk)).toBe(false);
  });

  it("is stale when a rebuild wrote the bundle after the process started", () => {
    const inlined: BundleFileMtime[] = [{ path: BUNDLE, mtimeMs: 1_000 }];
    const disk: BundleFileMtime[] = [{ path: BUNDLE, mtimeMs: 1_001 }];
    expect(isBundleStale(inlined, disk)).toBe(true);
  });

  it("is stale when the rebuild removed the file the module was loaded from", () => {
    const inlined: BundleFileMtime[] = [{ path: BUNDLE, mtimeMs: 1_000 }];
    const disk: BundleFileMtime[] = [{ path: BUNDLE, mtimeMs: null }];
    expect(isBundleStale(inlined, disk)).toBe(true);
  });

  it("ignores files that were never on disk at load", () => {
    const inlined: BundleFileMtime[] = [{ path: BUNDLE, mtimeMs: null }];
    const disk: BundleFileMtime[] = [{ path: BUNDLE, mtimeMs: 5_000 }];
    expect(isBundleStale(inlined, disk)).toBe(false);
  });
});

describe("warnIfBundleStale", () => {
  it("does not warn for the real, freshly built bundle on disk", () => {
    const log = vi.fn();
    // Runs first: the once-only flag is process-wide, later tests set it.
    expect(warnIfBundleStale({ log })).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("warns with the rebuild-and-restart line when the bundle is newer", () => {
    const log = vi.fn();
    const warned = warnIfBundleStale({
      log,
      inlined: [{ path: BUNDLE, mtimeMs: 1_000 }],
      disk: [{ path: BUNDLE, mtimeMs: 2_000 }],
    });
    expect(warned).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(STALE_BUNDLE_WARNING);
    expect(STALE_BUNDLE_WARNING).toContain("Rebuild and restart");
    expect(STALE_BUNDLE_WARNING).toContain("STALE inlined bundle");
  });

  it("warns only once per process — never once per request", () => {
    const log = vi.fn();
    const again = warnIfBundleStale({
      log,
      inlined: [{ path: BUNDLE, mtimeMs: 1_000 }],
      disk: [{ path: BUNDLE, mtimeMs: 2_000 }],
    });
    expect(again).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
