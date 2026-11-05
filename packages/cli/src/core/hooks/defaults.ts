/**
 * Shipped default hooks — materialisation + lookup (ADR-0006).
 *
 * The default SOURCES live in `defaults.generated.ts` (written by
 * `scripts/gen-hook-defaults.mjs`); this module only installs them to
 * `~/.vibeflow/hooks/defaults/after/<event>.mjs` and reads them back.
 * Upgrade rule: when `defaults/.version` differs from the built-in
 * `DEFAULT_HOOKS_VERSION`, the directory is rewritten WHOLESALE (atomic
 * tmp+rename, same pattern as `core/settings.ts`). `defaults/` is
 * documented as never-user-edited — edits there are lost by design, and
 * the rewrite prints one line saying so.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HookEvent } from "./envelope.js";
import {
  DEFAULT_HOOKS_VERSION,
  DEFAULT_HOOK_SOURCES,
} from "./defaults.generated.js";

export { DEFAULT_HOOKS_VERSION };

const ALL_EVENTS: HookEvent[] = [
  "task.create",
  "task.update",
  "task.claim",
  "task.delete",
  "task.comment",
  "push",
  "pull",
  "verify",
];

export function defaultsDir(home: string = homedir()): string {
  return join(resolve(home), ".vibeflow", "hooks", "defaults");
}

function versionFile(home: string): string {
  return join(defaultsDir(home), ".version");
}

export function shippedDefaultsVersion(home: string = homedir()): string | null {
  try {
    return readFileSync(versionFile(home), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Materialise shipped defaults when the version marker mismatches.
 * Idempotent: a matching marker is a no-op (no writes, no output).
 */
export function ensureShippedDefaults(home: string = homedir()): void {
  if (shippedDefaultsVersion(home) === DEFAULT_HOOKS_VERSION) return;
  const dir = join(defaultsDir(home), "after");
  mkdirSync(dir, { recursive: true });
  const tmpDir = `${dir}.tmp.${process.pid}`;
  mkdirSync(tmpDir, { recursive: true });
  for (const event of ALL_EVENTS) {
    const source = DEFAULT_HOOK_SOURCES[event];
    if (typeof source !== "string") continue;
    writeFileSync(join(tmpDir, `after-${event}.mjs`), source);
  }
  writeFileSync(join(tmpDir, ".version-tmp"), DEFAULT_HOOKS_VERSION + "\n");
  // Publish each file atomically, then the version marker last: a reader
  // never sees a new version with half-written sources.
  for (const event of ALL_EVENTS) {
    renameSync(join(tmpDir, `after-${event}.mjs`), join(dir, `after-${event}.mjs`));
  }
  renameSync(join(tmpDir, ".version-tmp"), versionFile(home));
  try {
    rmdirSync(tmpDir);
  } catch {
    /* best effort */
  }
  process.stderr.write(
    `hooks: shipped defaults (re)installed at ${dir} (v${DEFAULT_HOOKS_VERSION}) — edits there are lost on upgrade by design; override via .vibeflow-hooks/ or ~/.vibeflow/hooks/\n`,
  );
}

/** Canonical default source for one event (used when no project/global file wins). */
export function getDefaultHookSource(
  event: HookEvent,
  home: string = homedir(),
): { file: string } | null {
  const file = join(defaultsDir(home), "after", `after-${event}.mjs`);
  if (!existsSync(file)) return null;
  return { file };
}

/** The bundled (generated) source — what discovery falls back to conceptually. */
export function bundledDefaultSource(event: HookEvent): string | null {
  const source = DEFAULT_HOOK_SOURCES[event];
  return typeof source === "string" ? source : null;
}
