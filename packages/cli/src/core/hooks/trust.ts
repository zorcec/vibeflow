/**
 * Project-hook trust — direnv-style sha256 trust (ADR-0006).
 *
 * HONEST WORDING (load-bearing, pinned by `trust.test.ts`): trusting a
 * hook grants CODE-EXECUTION permission, NOT a sandbox. The entry-file
 * hash is NOT transitive integrity — a trusted `.mjs` file approves its
 * whole import graph, and the child reads with the user's HOME (and
 * therefore their credentials) visible. The prompt and the docs say this
 * plainly; anything softer is a lie about the security boundary.
 *
 * Rules:
 * - Only PROJECT hooks are untrusted. Global (`~/.vibeflow/hooks/`) and
 *   shipped defaults are the user's own bits — trusted without prompting.
 * - New file or changed sha256 → prompt `Run project hook …? [y/N/d]`
 *   (`d` prints the file first). Anything but `y` = not run, with a
 *   stderr line saying why.
 * - Non-TTY (agents/CI/MCP) cannot prompt → NOT run, says why. This
 *   refusal is IN SCOPE as a safety property (Stage 1, per ticket).
 * - Escape hatch: `VIBEFLOW_TRUST_HOOKS=1` (explicit, logged on stderr).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const TRUST_ENV_BYPASS = "VIBEFLOW_TRUST_HOOKS";

export interface TrustRecord {
  sha256: string;
  trustedAt: string;
}

export type TrustStore = Record<string, TrustRecord>;

export function trustFilePath(home: string = homedir()): string {
  return join(resolve(home), ".vibeflow", "hooks", "trust.json");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function loadTrustStore(home: string = homedir()): TrustStore {
  try {
    const raw = readFileSync(trustFilePath(home), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as TrustStore;
    }
    return {};
  } catch {
    return {};
  }
}

export function trustRecordExists(home: string): boolean {
  return existsSync(trustFilePath(home));
}

export function recordTrust(home: string, file: string, sha256: string): void {
  const path = trustFilePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const store = loadTrustStore(home);
  store[file] = { sha256, trustedAt: new Date().toISOString() };
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  // Atomic rename — a half-written trust store must never parse as trusted.
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
  }
}

export type TrustVerdict =
  | { trusted: true; reason: "global-or-default" | "recorded" | "env-bypass" }
  | { trusted: false; reason: "new" | "changed" | "declined" | "non-tty" | "escaped-root" };

export interface TrustCheckOptions {
  home?: string;
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Prompt implementation (default: read from stdin). Tests inject this. */
  prompt?: (question: string) => Promise<string>;
}

function defaultPrompt(question: string): Promise<string> {
  return new Promise((resolvePrompt) => {
    process.stderr.write(question);
    if (!process.stdin.readable) {
      resolvePrompt("");
      return;
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolvePrompt(chunk.trim());
    };
    process.stdin.on("data", onData);
  });
}

/**
 * Check (and, interactively, establish) trust for one resolved hook file.
 * `isProjectRoot` must be false for global/defaults files — those are the
 * user's own bits and never prompt.
 */
export async function checkHookTrust(
  file: string,
  opts: { isProjectRoot: boolean; escapedRoot: boolean } & TrustCheckOptions,
): Promise<TrustVerdict> {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;

  // A symlink escape never inherits trust from the directory it points
  // into: no trusted→untrusted and no untrusted→trusted inheritance.
  if (opts.escapedRoot) {
    process.stderr.write(
      `hook trust: ${file} escapes its hooks directory via symlink — not running (symlinks never inherit trust)\n`,
    );
    return { trusted: false, reason: "escaped-root" };
  }

  if (!opts.isProjectRoot) return { trusted: true, reason: "global-or-default" };
  if (env[TRUST_ENV_BYPASS] === "1") {
    process.stderr.write(`hook trust: ${file} allowed via ${TRUST_ENV_BYPASS}=1\n`);
    return { trusted: true, reason: "env-bypass" };
  }

  const digest = sha256File(file);
  const store = loadTrustStore(home);
  const record = store[file];
  const tty = opts.tty ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);

  if (record && record.sha256 === digest) return { trusted: true, reason: "recorded" };

  const changed = record !== undefined;
  if (!tty) {
    process.stderr.write(
      `hook trust: ${file} is a project hook and trust is not recorded — not running (non-interactive; approve it once from a terminal, or set VIBEFLOW_TRUST_HOOKS=1)\n` +
        `Trusting a hook grants CODE EXECUTION on this machine — it is not a sandbox. The recorded hash covers the entry file only, not its imports.\n`,
    );
    return { trusted: false, reason: "non-tty" };
  }

  const prompt = opts.prompt ?? defaultPrompt;
  const answer = (
    await prompt(
      `Run project hook ${file}?\n` +
        `Trusting a hook grants CODE EXECUTION on this machine — it is not a sandbox. ` +
        `The recorded hash covers the entry file only, not its imports.\n` +
        `Run project hook? [y/N/d] `,
    )
  )
    .trim()
    .toLowerCase();
  if (answer === "d") {
    process.stderr.write(readFileSync(file, "utf8") + "\n");
    const second = ((await prompt(`Run project hook ${file}? [y/N] `)) ?? "")
      .trim()
      .toLowerCase();
    if (second !== "y" && second !== "yes") {
      process.stderr.write(`hook trust: ${file} declined — not running\n`);
      return { trusted: false, reason: "declined" };
    }
    recordTrust(home, file, digest);
    return { trusted: true, reason: "recorded" };
  }
  if (answer !== "y" && answer !== "yes") {
    process.stderr.write(
      `hook trust: ${file} ${changed ? "changed since approval" : "is new"} — not running (answer was not 'y')\n`,
    );
    return { trusted: false, reason: changed ? "changed" : "declined" };
  }
  recordTrust(home, file, digest);
  return { trusted: true, reason: "recorded" };
}
