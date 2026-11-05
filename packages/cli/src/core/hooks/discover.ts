/**
 * Hook discovery + precedence — one file per (phase, event) (ADR-0006).
 *
 * Precedence: project > global > shipped default. The FIRST hit wins and an
 * override REPLACES the default — it never merges, so a later default
 * change cannot silently alter an overridden behaviour.
 *
 * Safety rules (all pinned by `discover.test.ts`):
 * - Only `*.mjs` is recognised. `*.js`/`.cjs` beside it are REFUSED LOUDLY
 *   (an ignored `.cjs` would look like a working policy that never runs).
 * - Canonical roots + regular-file checks: hook paths are resolved to
 *   canonical absolute paths and must be regular files.
 * - Symlink rule: a symlink may not escape its own trust root — a hook
 *   resolved from an UNTRUSTED root (project) that links into a TRUSTED
 *   root (global/defaults/home) does NOT inherit trust, and a trusted-root
 *   hook that links OUT to untrusted territory is refused. Trust follows
 *   the file the hook actually executes, not the path that named it.
 * - Unknown event directories under `.vibeflow-hooks/` are reported once
 *   on stderr (`HOOK_UNKNOWN_EVENT`), never guessed at.
 */
import { realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HookEvent, HookPhase } from "./envelope.js";

export const HOOK_FILE_SUFFIX = ".mjs";

/** Refused extensions — present but never executed, reported loudly. */
const REFUSED_SUFFIXES = [".js", ".cjs"];

/** The 8 known events; anything else under a hooks dir is unknown. */
const KNOWN_EVENTS: ReadonlySet<string> = new Set<string>([
  "task.create",
  "task.update",
  "task.claim",
  "task.delete",
  "task.comment",
  "push",
  "pull",
  "verify",
]);

export type HookTrustRoot = "project" | "global" | "defaults";

export interface ResolvedHook {
  /** Canonical absolute path of the file that would execute. */
  file: string;
  root: HookTrustRoot;
  /** True when the final target escaped its own trust root via symlink. */
  escapedRoot: boolean;
}

export interface HookRoots {
  project: string;
  global: string;
  defaults: string;
}

export function hookRoots(projectDir: string, home: string = homedir()): HookRoots {
  return {
    project: join(resolve(projectDir), ".vibeflow-hooks"),
    global: join(resolve(home), ".vibeflow", "hooks"),
    defaults: join(resolve(home), ".vibeflow", "hooks", "defaults"),
  };
}

function hookFileName(phase: HookPhase, event: HookEvent): string {
  return `${phase}-${event}${HOOK_FILE_SUFFIX}`;
}

function isRegularFile(path: string): boolean {
  // statSync FOLLOWS symlinks: a link to a regular file counts (the escape
  // rule is enforced separately via canonicalWithinRoot). Dangling links
  // throw and count as missing.
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the symlink target WITHOUT following through to execution:
 * returns the canonical path of `path` (following every link) and whether
 * the canonical path stays inside `rootDir`.
 */
function canonicalWithinRoot(path: string, rootDir: string): { canonical: string; inside: boolean } {
  const canonical = realpathSync(path);
  const root = realpathSync(rootDir);
  const inside = canonical === root || canonical.startsWith(root + "/");
  return { canonical, inside };
}

/**
 * Refused-extension check: a `.js`/`.cjs` file for the same (phase, event)
 * in the SAME directory as a lookup. Returns the offending path or null.
 * Callers report it loudly (stderr) — never silently ignore it.
 */
export function refusedSibling(dir: string, phase: HookPhase, event: HookEvent): string | null {
  for (const suffix of REFUSED_SUFFIXES) {
    const candidate = join(dir, `${phase}-${event}${suffix}`);
    if (isRegularFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve one (phase, event) hook: project → global → defaults, first hit
 * wins. Returns null when nothing exists. The returned `file` is the
 * canonical path; `escapedRoot` marks a symlink escape (callers treat an
 * escape as untrusted-at-best and never let an untrusted-root hook inherit
 * trust from the directory it points into).
 */
export function resolveHookFile(
  projectDir: string,
  phase: HookPhase,
  event: HookEvent,
  home: string = homedir(),
): ResolvedHook | null {
  const roots = hookRoots(projectDir, home);
  const ordered: Array<{ dir: HookRoots[keyof HookRoots]; root: HookTrustRoot }> = [
    { dir: roots.project, root: "project" },
    { dir: roots.global, root: "global" },
    { dir: roots.defaults, root: "defaults" },
  ];
  for (const { dir, root } of ordered) {
    const candidate = join(dir, phase, hookFileName(phase, event));
    if (!isRegularFile(candidate)) continue;
    // Canonicalise: the file that executes is the link TARGET, not the name.
    let canonical = candidate;
    let inside = true;
    try {
      const resolved = canonicalWithinRoot(candidate, dir);
      canonical = resolved.canonical;
      inside = resolved.inside;
    } catch {
      // Unresolvable link target — treat as missing, keep looking.
      continue;
    }
    // The executed file must itself be a regular file (no dir/fifo).
    if (!isRegularFile(canonical)) continue;
    return { file: canonical, root, escapedRoot: !inside };
  }
  return null;
}

/** Warn-once registry for unknown event directories (per process). */
const warnedUnknownEvents = new Set<string>();

export function reportUnknownHookEvents(
  projectDir: string,
  onWarn: (message: string) => void = (m) => process.stderr.write(m + "\n"),
): void {
  for (const phase of ["pre", "after"] as const) {
    let entries: string[];
    try {
      entries = readdirSync(join(resolve(projectDir), ".vibeflow-hooks", phase));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(HOOK_FILE_SUFFIX)) continue;
      const event = entry.slice(phase.length + 1, -HOOK_FILE_SUFFIX.length);
      const key = `${phase}:${event}`;
      if (!KNOWN_EVENTS.has(event) && !warnedUnknownEvents.has(key)) {
        warnedUnknownEvents.add(key);
        onWarn(`HOOK_UNKNOWN_EVENT: .vibeflow-hooks/${phase}/${entry} names an unknown event "${event}" — ignored`);
      }
    }
  }
}
