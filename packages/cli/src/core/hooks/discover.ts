/**
 * Hook discovery + precedence — one file per (tool, phase) (ADR-0007).
 *
 * A hook key is the canonical TOOL (`tasks`, `auth.login`, `create_task`)
 * plus the phase suffix: `<tool>.before.mjs` / `<tool>.after.mjs` (and
 * the `.hook.mjs` / `.hook.mts` / `.hook.ts` module peers). Hook
 * directories are FLAT — `<root>/tasks.after.mjs`, no `pre/`/`after/`
 * subdirectory.
 *
 * Precedence: project > global > shipped. The FIRST hit wins and an
 * override REPLACES the default — it never merges, so a later default
 * change cannot silently alter an overridden behaviour.
 *
 * Safety rules (all pinned by `discover.test.ts`):
 * - Only executable suffixes run. `.<phase>.js`/`.cjs`/bare `.ts`/bare
 *   `.mts` beside them are REFUSED LOUDLY (an ignored file that looks
 *   like working policy but never runs is worse than no hook).
 * - Canonical roots + regular-file checks: hook paths are resolved to
 *   canonical absolute paths and must be regular files.
 * - Symlink rule: a symlink may not escape its own trust root — a hook
 *   resolved from an UNTRUSTED root (project) that links into a TRUSTED
 *   root (global/shipped/home) does NOT inherit trust, and a trusted-root
 *   hook that links OUT to untrusted territory is refused. Trust follows
 *   the file the hook actually executes, not the path that named it. A
 *   shipped file that symlinks out is refused as `HOOK_SHIPPED_ESCAPED`.
 * - Unknown tool names and unsupported cells (`.before` on a read tool,
 *   anything on `mcp` after / the `authors` container) are reported once
 *   on stderr, never guessed at.
 */
import { realpathSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookPhase } from "./envelope.js";
import { canonicalHookTool, findHookTool } from "./tools.js";

export const HOOK_FILE_SUFFIX = ".mjs";
/** Module-adapter suffix (Stage 1.5, kept in v2): a default-export
 *  `.hook.mjs` peer next to the stdio `<tool>.<phase>.mjs` at the same
 *  precedence level. */
export const HOOK_MODULE_SUFFIX = ".hook.mjs";

/** TypeScript module-adapter suffixes (Stage 4, kept in v2): default-export
 *  `.hook.mts` / `.hook.ts` peers — same deterministic filename contract,
 *  no auto-detection, erasable-syntax-only (type stripping, never
 *  compilation). */
export const HOOK_TS_MODULE_SUFFIXES = [".hook.mts", ".hook.ts"] as const;

/** Deterministic mode choice: filename extension only, never source inspection. */
export type HookMode = "stdio" | "module" | "module-ts";

/**
 * Refused extensions — present but never executed, reported loudly.
 * `.<phase>.js`/`.cjs`/bare `.ts`/bare `.mts` (without the `.hook.`
 * adapter infix) are refused like before: an ignored file that looks like
 * policy but never runs is worse than no hook.
 */
function refusedSuffixesFor(phase: HookPhase): string[] {
  return [`.${phase}.js`, `.${phase}.cjs`, `.${phase}.ts`, `.${phase}.mts`];
}


/**
 * Parse one directory entry into (tool, phase). The phase is the parse
 * ANCHOR — a tool name may contain dots but never a `before`/`after`
 * segment (guard-tested), so ambiguous parses are impossible.
 */
// Tool segments admit dots (auth.login) and underscores (create_task) but
// never a bare `before`/`after` segment (guard-tested in tool-contract) —
// the phase stays the unambiguous parse anchor.
const HOOK_FILE_RE =
  /^(?<tool>[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*)\.(?<phase>before|after)\.(?<rest>mjs|hook\.mjs|hook\.mts|hook\.ts|js|cjs|ts|mts)$/;

export interface ParsedHookFile {
  tool: string;
  phase: HookPhase;
  executable: boolean;
  mode: HookMode | null;
}

export function parseHookFileName(entry: string): ParsedHookFile | null {
  const m = HOOK_FILE_RE.exec(entry);
  if (!m?.groups) return null;
  const tool = m.groups["tool"] as string;
  const phase = m.groups["phase"] as HookPhase;
  const rest = m.groups["rest"] as string;
  switch (rest) {
    case "mjs":
      return { tool, phase, executable: true, mode: "stdio" };
    case "hook.mjs":
      return { tool, phase, executable: true, mode: "module" };
    case "hook.mts":
    case "hook.ts":
      return { tool, phase, executable: true, mode: "module-ts" };
    default:
      return { tool, phase, executable: false, mode: null };
  }
}

export type HookTrustRoot = "project" | "global" | "shipped";

export interface ResolvedHook {
  /** Canonical absolute path of the file that would execute. */
  file: string;
  root: HookTrustRoot;
  /** True when the final target escaped its own trust root via symlink. */
  escapedRoot: boolean;
  /** Deterministic by filename: `<tool>.<phase>.mjs` = stdio,
   *  `<tool>.<phase>.hook.mjs` = module,
   *  `<tool>.<phase>.hook.mts` / `<tool>.<phase>.hook.ts` = module-ts. */
  mode: HookMode;
}

/**
 * Same-level executable collision: two or more of the four executable
 * names (`<tool>.<phase>.mjs`, `.hook.mjs`, `.hook.mts`, `.hook.ts`)
 * exist at the same precedence level. This is a configuration error for
 * the invocation — diagnostic on stderr, no hook, and NO fallback to a
 * lower level. `files` carries every same-level executable found, in
 * deterministic probe order (stdio, `.hook.mjs`, `.hook.mts`, `.hook.ts`).
 */
export interface HookConflict {
  conflict: true;
  root: HookTrustRoot;
  files: string[];
}

/** Discriminated resolution: a hook, an explicit conflict, or nothing. */
export type HookResolution = ResolvedHook | HookConflict | null;

/** Narrowing guard for the conflict branch of {@link HookResolution}. */
export function isHookConflict(res: HookResolution): res is HookConflict {
  return res !== null && (res as HookConflict).conflict === true;
}

export interface HookRoots {
  project: string;
  global: string;
  shipped: string | null;
}

export interface HookRootsOptions {
  home?: string;
  /** Test seam / explicit override: the shipped root (null = none). */
  shippedDir?: string | null;
  /** Test seam for layout-matrix tests: derive the shipped root from this bundle URL. */
  bundleUrl?: string | URL;
}

export function hookRoots(projectDir: string, opts?: HookRootsOptions): HookRoots {
  const home = opts?.home ?? homedir();
  return {
    project: join(resolve(projectDir), ".vibeflow-hooks"),
    global: join(resolve(home), ".vibeflow", "hooks"),
    shipped:
      opts?.shippedDir !== undefined
        ? opts.shippedDir
        : resolveShippedDefaultsDir(opts),
  };
}

export function hookFileName(tool: string, phase: HookPhase, mode: HookMode): string;
export function hookFileName(tool: string, phase: HookPhase): string;
export function hookFileName(tool: string, phase: HookPhase, mode: HookMode = "stdio"): string {
  switch (mode) {
    case "module":
      return `${tool}.${phase}${HOOK_MODULE_SUFFIX}`;
    case "module-ts":
      return `${tool}.${phase}.hook.ts`;
    default:
      return `${tool}.${phase}${HOOK_FILE_SUFFIX}`;
  }
}

/** All four executable peer names for one (tool, phase), in probe order. */
export function hookExecutableFileNames(tool: string, phase: HookPhase): string[] {
  return [
    hookFileName(tool, phase, "stdio"),
    hookFileName(tool, phase, "module"),
    ...HOOK_TS_MODULE_SUFFIXES.map((suffix) => `${tool}.${phase}${suffix}`),
  ];
}

/**
 * Canonicalise one candidate hook path: follows every symlink and reports
 * whether the final target stays inside its own trust root. Returns null
 * when the candidate is missing, not a regular file, or unresolvable —
 * the caller treats that as "absent at this level" and keeps looking.
 */
function canonicalCandidate(
  candidate: string,
  rootDir: string,
): { canonical: string; inside: boolean } | null {
  if (!isRegularFile(candidate)) return null;
  let resolved: { canonical: string; inside: boolean };
  try {
    resolved = canonicalWithinRoot(candidate, rootDir);
  } catch {
    // Unresolvable link target — treat as missing, keep looking.
    return null;
  }
  // The executed file must itself be a regular file (no dir/fifo).
  if (!isRegularFile(resolved.canonical)) return null;
  return resolved;
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
 * Refused-extension check: a `.<phase>.js`/`.cjs`/bare-`.ts`/bare-`.mts`
 * file for the same (tool, phase) in the SAME directory as a lookup.
 * Returns the offending path or null. Callers report it loudly (stderr) —
 * never silently ignore it.
 */
export function refusedSibling(dir: string, tool: string, phase: HookPhase): string | null {
  for (const suffix of refusedSuffixesFor(phase)) {
    const candidate = join(dir, `${tool}${suffix}`);
    if (isRegularFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve one (tool, phase) hook: project → global → shipped, first hit
 * wins. At each level ALL FOUR exact names are probed before descending:
 * `<tool>.<phase>.mjs` (stdio), `<tool>.<phase>.hook.mjs` (module),
 * `<tool>.<phase>.hook.mts` / `<tool>.<phase>.hook.ts` (module-ts).
 * The first level with any file wins; two or more at one level is an
 * explicit {@link HookConflict}, never a silent fallback. Returns null
 * when nothing exists. The returned `file` is the canonical path;
 * `escapedRoot` marks a symlink escape (callers treat an escape as
 * untrusted-at-best and never let an untrusted-root hook inherit trust
 * from the directory it points into). A conflicting, broken, untrusted,
 * or escaped chosen file is never replaced by a lower-level hook.
 */
export function resolveHookFile(
  projectDir: string,
  tool: string,
  phase: HookPhase,
  opts?: HookRootsOptions,
): HookResolution {
  // Only registry keys with a supported cell resolve: unknown tools and
  // unsupported cells (non-gateable `.before`, `mcp.after`, the `authors`
  // container) NEVER execute — the scanner reports them loudly instead
  // (`HOOK_UNKNOWN_TOOL` / `HOOK_NOT_GATEABLE` / `HOOK_NO_AFTER` /
  // `HOOK_CONTAINER_TOOL`). Aliases resolve to their canonical key.
  const spec = findHookTool(canonicalHookTool(tool));
  if (!spec || spec[phase].status === "unsupported") return null;
  const roots = hookRoots(projectDir, opts);
  const ordered: Array<{ dir: string | null; root: HookTrustRoot }> = [
    { dir: roots.project, root: "project" },
    { dir: roots.global, root: "global" },
    { dir: roots.shipped, root: "shipped" },
  ];
  for (const { dir, root } of ordered) {
    if (dir === null) continue;
    // A missing root directory is "absent at this level", not an error —
    // realpathSync on it would throw inside canonicalWithinRoot.
    try {
      realpathSync(dir);
    } catch {
      continue;
    }
    const present: Array<{ found: { canonical: string; inside: boolean } | null; mode: HookMode }> =
      [
        { found: canonicalCandidate(join(dir, hookFileName(tool, phase, "stdio")), dir), mode: "stdio" as const },
        { found: canonicalCandidate(join(dir, hookFileName(tool, phase, "module")), dir), mode: "module" as const },
        ...HOOK_TS_MODULE_SUFFIXES.map(
          (suffix): { found: { canonical: string; inside: boolean } | null; mode: HookMode } => ({
            found: canonicalCandidate(join(dir, `${tool}.${phase}${suffix}`), dir),
            mode: "module-ts" as const,
          }),
        ),
      ].filter((entry) => entry.found !== null);
    if (present.length > 1) {
      return {
        conflict: true,
        root,
        files: present.map(
          (entry) => (entry.found as { canonical: string }).canonical,
        ),
      };
    }
    const chosen = present[0];
    if (chosen === undefined || chosen.found === null) continue;
    // Canonicalise: the file that executes is the link TARGET, not the name.
    return {
      file: chosen.found.canonical,
      root,
      escapedRoot: !chosen.found.inside,
      mode: chosen.mode,
    };
  }
  return null;
}

/**
 * One scanner replacing v1's two mechanisms (`reportUnknownHookEvents`
 * and the per-lookup `refusedSibling` call): reads the flat roots once
 * and warns ONCE PER PATH for every unrunnable file —
 * - refused suffixes (`HOOK_BAD_EXTENSION`),
 * - unknown tools (`HOOK_UNKNOWN_TOOL`),
 * - known tools with an unsupported cell (`HOOK_NOT_GATEABLE` /
 *   `HOOK_NO_AFTER` / `HOOK_CONTAINER_TOOL`).
 */
export function reportUnrunnableHookFiles(
  projectDir: string,
  opts?: HookRootsOptions & {
    onWarn?: (message: string) => void;
  },
): void {
  const onWarn = opts?.onWarn ?? ((m: string): void => {
    process.stderr.write(m + "\n");
  });
  const roots = hookRoots(projectDir, opts);
  const levels: Array<string | null> = [roots.project, roots.global, roots.shipped];
  for (const dir of levels) {
    if (dir === null) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const key = `${dir}/${entry}`;
      if (warnedPaths.has(key)) continue;
      const parsed = parseHookFileName(entry);
      if (parsed === null) continue; // trust.json, bypass-audit.log, *.config.json …
      if (!parsed.executable) {
        warnedPaths.add(key);
        onWarn(
          `HOOK_BAD_EXTENSION (${key} — only *.mjs and .hook.mjs/.hook.mts/.hook.ts execute; rename it or it never runs)`,
        );
        continue;
      }
      const tool = canonicalHookTool(parsed.tool);
      const spec = findHookTool(tool);
      if (!spec) {
        warnedPaths.add(key);
        onWarn(`HOOK_UNKNOWN_TOOL (${key} names an unknown tool "${parsed.tool}" — ignored)`);
        continue;
      }
      const cell = spec[parsed.phase];
      if (cell.status === "unsupported") {
        warnedPaths.add(key);
        const code =
          cell.reason === "not-gateable"
            ? "HOOK_NOT_GATEABLE"
            : cell.reason === "no-after"
              ? "HOOK_NO_AFTER"
              : "HOOK_CONTAINER_TOOL";
        onWarn(
          `${code} (${key} — "${spec.tool}" does not support .${parsed.phase} hooks — ignored)`,
        );
      }
    }
  }
}

/** Warn-once registry for unrunnable files (per path, per process). */
const warnedPaths = new Set<string>();

/** Test seam: re-arm the warn-once registry. */
export function resetUnrunnableHookWarnings(): void {
  warnedPaths.clear();
}

/**
 * Shipped-defaults root derivation (ADR-0007 D12): derived, never
 * configured. Tries, in order, `<bundleUrl>/./hooks/defaults`,
 * `<bundleUrl>/../hooks/defaults`, `<bundleUrl>/./defaults` and takes the
 * first whose `VERSION` marker file exists; the result is realpath'd.
 * Works unchanged for npm nested installs, pnpm symlink-into-store,
 * npx cache, global install and tarball — the root moves WITH the file,
 * so legitimate layouts can never look like escapes. No candidate
 * resolves ⇒ null (the caller prints HOOK_SHIPPED_DEFAULTS_MISSING).
 */
export function resolveShippedDefaultsDir(opts?: {
  bundleUrl?: string | URL;
}): string | null {
  const base =
    opts?.bundleUrl !== undefined
      ? opts.bundleUrl
      : new URL("./defaults-marker", import.meta.url);
  const baseStr = typeof base === "string" ? base : base.href;
  const candidates = ["./hooks/defaults", "../hooks/defaults", "./defaults"];
  for (const rel of candidates) {
    try {
      const url = new URL(rel + "/VERSION", baseStr);
      if (url.protocol !== "file:") continue;
      const dir = fileURLToPath(new URL(rel + "/", baseStr));
      statSync(join(dir, "VERSION"));
      return realpathSync(dir);
    } catch {
      continue;
    }
  }
  return null;
}
