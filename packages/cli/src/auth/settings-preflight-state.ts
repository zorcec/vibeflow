/**
 * Cross-process settings pre-flight state (ticket d5178789).
 *
 * The 5-minute debounce in `login.ts` was module-memory-only, so every CLI
 * invocation — a fresh process — re-checked `/api/v0/settings` (measured
 * 51 requests in 25 minutes). This module persists a tiny
 * `{ identityHash, checkedAt, settingsHash, settingsFingerprint }` stamp
 * in a project-local, UNSYNCED state dir:
 * `<project>/.vibeflow-state/settings-preflight.json`.
 *
 * - NOT the synced store: nothing here enters `.vibeflow/`, settings.json,
 *   or push/pull archives. No secrets, no settings payload — only hashes
 *   and a timestamp.
 * - Identity separates accounts/tokens/API rotations without storing a
 *   token: `sha256(canonical-api-base + NUL + bearer)`.
 * - Fingerprint binds the stamp to the settings bytes actually available
 *   to this invocation, so an independently changed/deleted cache cannot
 *   hide behind a fresh stamp.
 * - Concurrent invocations take a NON-BLOCKING exclusive lease
 *   (`settings-preflight.lock`, `wx` create): the winner refreshes, the
 *   loser keeps current settings and continues (fail-open, never waits).
 * - Everything here is best-effort and NEVER throws: a corrupt, oversized,
 *   unknown-version, or unwritable state file is a cache miss, not a
 *   command failure. Stuck leases never block task commands.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROTO_DIR } from "../core/types.js";

/** Current on-disk format version. Unknown versions are cache misses. */
export const PREFLIGHT_STATE_VERSION = 1 as const;

/** Unsynced runtime dir (sibling of `.vibeflow`, never inside it). */
export const PREFLIGHT_STATE_DIRNAME = ".vibeflow-state";

const STATE_FILENAME = "settings-preflight.json";
const LOCK_FILENAME = "settings-preflight.lock";

/** Oversized state files are corrupt by definition — ignore, never parse. */
const MAX_STATE_BYTES = 64 * 1024;

/**
 * A lease older than this is crashed/stale and may be taken over.
 * Above the 3-second pre-flight deadline so a live holder is never
 * mistaken for a crashed one.
 */
export const PREFLIGHT_LEASE_STALE_MS = 10_000;

export interface PreflightDiskState {
  version: typeof PREFLIGHT_STATE_VERSION;
  identityHash: string;
  checkedAt: number;
  settingsHash: string | null;
  settingsFingerprint: string | null;
}

export interface PreflightPaths {
  dir: string;
  stateFile: string;
  lockFile: string;
}

/** Marker for a settings file that is absent or unreadable. */
export const SETTINGS_MISSING = "#missing" as const;

export function resolvePreflightPaths(projectDir: string): PreflightPaths {
  const dir = join(projectDir, PREFLIGHT_STATE_DIRNAME);
  return {
    dir,
    stateFile: join(dir, STATE_FILENAME),
    lockFile: join(dir, LOCK_FILENAME),
  };
}

/** Account/API/token rotation key — a digest, never the credential. */
export function identityHashFor(apiUrl: string, token: string): string {
  return createHash("sha256").update(`${apiUrl}\u0000${token}`).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return SETTINGS_MISSING;
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? SETTINGS_MISSING;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    );
  return `{${entries.join(",")}}`;
}

/**
 * Pure fingerprint over the settings content available to this
 * invocation. Missing files hash as a marker, never as `{}` — so a
 * deleted cache cannot fingerprint-match a stamp taken while it existed.
 */
export function fingerprintSettings(
  globalSettings: SettingsPart,
  projectSettings: SettingsPart,
): string {
  return createHash("sha256")
    .update(`global:${stableStringify(globalSettings)}\nproject:${stableStringify(projectSettings)}`)
    .digest("hex");
}

function globalSettingsPath(): string {
  return join(homedir(), ".vibeflow", "settings.json");
}

/** Arbitrary parsed settings JSON. */
export type SettingsJsonValue =
  | string
  | number
  | boolean
  | null
  | SettingsJsonValue[]
  | { [key: string]: SettingsJsonValue };

/** Parsed settings content, or the missing-file marker. */
export type SettingsPart = SettingsJsonValue | typeof SETTINGS_MISSING;

function readJsonFileOrMissing(path: string): SettingsPart {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SettingsJsonValue;
  } catch {
    return SETTINGS_MISSING;
  }
}

/**
 * The settings parts the fingerprint binds to: parsed global file and
 * parsed project file, each a missing-marker when absent/unreadable.
 * Read-only; never creates anything.
 */
export function readSettingsParts(projectDir: string): {
  global: SettingsPart;
  project: SettingsPart;
  // SAFETY: readJsonFileOrMissing already returns SettingsPart; the
  // annotation only names the boundary type for the lens no-unknown rule.
} {
  return {
    global: readJsonFileOrMissing(globalSettingsPath()),
    project: readJsonFileOrMissing(
      join(projectDir, PROTO_DIR, "settings.json"),
    ),
  };
}

/** Fail-open read: any problem is a miss (`null`), never a throw. */
export function readPreflightState(
  projectDir: string,
): PreflightDiskState | null {
  try {
    const { stateFile } = resolvePreflightPaths(projectDir);
    let size = 0;
    try {
      size = statSync(stateFile).size;
    } catch {
      return null;
    }
    if (size > MAX_STATE_BYTES) return null;
    const parsed = JSON.parse(
      readFileSync(stateFile, "utf-8"),
    ) as Partial<PreflightDiskState>;
    if (parsed?.version !== PREFLIGHT_STATE_VERSION) return null;
    if (
      typeof parsed.identityHash !== "string" ||
      parsed.identityHash.length === 0
    ) {
      return null;
    }
    if (
      typeof parsed.checkedAt !== "number" ||
      !Number.isInteger(parsed.checkedAt) ||
      parsed.checkedAt < 0
    ) {
      return null;
    }
    if (
      parsed.settingsHash !== null &&
      typeof parsed.settingsHash !== "string"
    ) {
      return null;
    }
    if (
      parsed.settingsFingerprint !== null &&
      parsed.settingsFingerprint !== undefined &&
      typeof parsed.settingsFingerprint !== "string"
    ) {
      return null;
    }
    return {
      version: PREFLIGHT_STATE_VERSION,
      identityHash: parsed.identityHash,
      checkedAt: parsed.checkedAt,
      settingsHash: parsed.settingsHash ?? null,
      settingsFingerprint: parsed.settingsFingerprint ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Fail-open persist: atomic same-dir rename of a uniquely-named temp
 * file (`0600`), state dir at `0700`. Never throws; a failed write simply
 * leaves the next invocation eligible.
 */
export function persistPreflightState(
  projectDir: string,
  state: Omit<PreflightDiskState, "version">,
): void {
  const { dir, stateFile } = resolvePreflightPaths(projectDir);
  const tmp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      tmp,
      JSON.stringify({ version: PREFLIGHT_STATE_VERSION, ...state }),
      { mode: 0o600 },
    );
    renameSync(tmp, stateFile);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup only */
    }
  }
}

export interface PreflightLease {
  held: boolean;
  release: () => void;
}

function releasePreflightLease(lockFile: string, nonce: string): void {
  try {
    const raw = readFileSync(lockFile, "utf-8");
    if ((JSON.parse(raw) as { nonce?: unknown }).nonce !== nonce) return;
    unlinkSync(lockFile);
  } catch {
    /* ownership changed or already gone — nothing to release */
  }
}

/**
 * Non-blocking exclusive lease. The winner refreshes and persists; a
 * loser (`held: false`) keeps current settings and continues WITHOUT
 * waiting — contention must never become a CLI hang. A stale lock (older
 * than `PREFLIGHT_LEASE_STALE_MS`, or unparseable) is taken over; the
 * takeover re-checks ownership on release so an old owner can never
 * delete a replacement owner's live lease. Never throws.
 */
export function acquirePreflightLease(
  projectDir: string,
  now: number = Date.now(),
): PreflightLease {
  const noop: PreflightLease = { held: false, release: () => {} };
  try {
    const { dir, lockFile } = resolvePreflightPaths(projectDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const nonce = `${process.pid}:${now}:${randomUUID()}`;
    const claim = (): PreflightLease | null => {
      try {
        const fd = openSync(lockFile, "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ nonce, at: now }));
        closeSync(fd);
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== "EEXIST") return null;
        return null;
      }
      return {
        held: true,
        release: () => releasePreflightLease(lockFile, nonce),
      };
    };
    const first = claim();
    if (first) return first;
    // Someone holds (or held) the lock: live leases lose fast, stale
    // ones are taken over. Unparseable content proves nothing live, so
    // it counts as stale — the worst case is one redundant refresh.
    let raw = "";
    try {
      raw = readFileSync(lockFile, "utf-8");
    } catch {
      return noop;
    }
    let at = NaN;
    try {
      at = (JSON.parse(raw) as { at?: unknown }).at as number;
    } catch {
      at = NaN;
    }
    if (Number.isFinite(at) && now - (at as number) < PREFLIGHT_LEASE_STALE_MS) {
      return noop;
    }
    // Stale recovery: remove ONLY the lock we inspected, then re-create
    // exclusively — if another process won the race, `wx` fails and we
    // lose fast instead of deleting its live lease.
    try {
      unlinkSync(lockFile);
    } catch {
      return noop;
    }
    // If the unlink removed a lock a live owner just replaced, our `wx`
    // below either fails (they re-created first → we lose fast) or
    // succeeds (their release is a nonce-mismatch no-op → their state
    // stands, ours merely re-stamps it). Either way no hang, no loss.
    return claim() ?? noop;
  } catch {
    return noop;
  }
}
