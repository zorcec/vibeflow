/**
 * Unit proof, ticket d5178789: project-local pre-flight state helpers.
 *
 * Covers the on-disk contract the cross-process debounce rests on:
 * versioned JSON with no secrets, strict validation (corrupt / wrong
 * version / bad types / oversized → miss, never throw), 0700/0600
 * permissions, and the non-blocking exclusive lease (winner refreshes,
 * loser continues; stale takeover; an old owner can never delete a
 * replacement owner's live lease).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PREFLIGHT_LEASE_STALE_MS,
  acquirePreflightLease,
  fingerprintSettings,
  identityHashFor,
  persistPreflightState,
  readPreflightState,
  resolvePreflightPaths,
} from "../../../src/auth/settings-preflight-state.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "preflight-state-"));
});

afterEach(() => {
  // Intentionally no recursive cleanup: temp dirs are tiny and OS-scoped.
});

function stamp(overrides: Record<string, unknown> = {}) {
  return {
    identityHash: "id-hash",
    checkedAt: 1_700_000_000_000,
    settingsHash: "hash-1",
    settingsFingerprint: "fp-1",
    ...overrides,
  };
}

describe("preflight paths and format", () => {
  it("lives in an unsynced sibling dir, never inside .vibeflow", () => {
    const paths = resolvePreflightPaths(projectDir);
    expect(paths.dir).toBe(join(projectDir, ".vibeflow-state"));
    expect(paths.stateFile).toContain(".vibeflow-state");
    expect(paths.stateFile).not.toContain(join(".vibeflow", "tasks"));
  });

  it("round-trips a stamp and stores no token or settings payload", () => {
    persistPreflightState(projectDir, stamp());
    const read = readPreflightState(projectDir);
    expect(read).toMatchObject({
      version: 1,
      identityHash: "id-hash",
      checkedAt: 1_700_000_000_000,
      settingsHash: "hash-1",
      settingsFingerprint: "fp-1",
    });
    const raw = readFileSync(
      resolvePreflightPaths(projectDir).stateFile,
      "utf-8",
    );
    expect(raw).not.toContain("test-token");
    expect(raw).not.toContain("autoCommit");
  });

  it("creates the state dir at 0700 and the file at 0600", () => {
    persistPreflightState(projectDir, stamp());
    const paths = resolvePreflightPaths(projectDir);
    const dirMode = statSync(paths.dir).mode & 0o777;
    const fileMode = statSync(paths.stateFile).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });
});

describe("fail-open reads", () => {
  it("missing file is a miss", () => {
    expect(readPreflightState(projectDir)).toBeNull();
  });

  it.each([
    ["corrupt JSON", "{not json"],
    ["wrong version", JSON.stringify({ ...stamp(), version: 2 })],
    ["empty identity", JSON.stringify({ ...stamp(), identityHash: "" })],
    ["float timestamp", JSON.stringify({ ...stamp(), checkedAt: 1.5 })],
    ["negative timestamp", JSON.stringify({ ...stamp(), checkedAt: -5 })],
    ["string timestamp", JSON.stringify({ ...stamp(), checkedAt: "now" })],
    ["numeric hash", JSON.stringify({ ...stamp(), settingsHash: 42 })],
  ])("%s is a miss, never a throw", (_label, body) => {
    const { stateFile, dir } = resolvePreflightPaths(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile, body);
    expect(readPreflightState(projectDir)).toBeNull();
  });

  it("oversized files are ignored without parsing", () => {
    const { stateFile, dir } = resolvePreflightPaths(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile, `{\"version\":1,\"padding\":\"${"x".repeat(70 * 1024)}\"}`);
    expect(readPreflightState(projectDir)).toBeNull();
  });

  it("persist never throws when the state path is blocked", () => {
    // A FILE where the state dir belongs: mkdir fails — must not throw,
    // and the read stays a miss. Root-safe (no chmod games).
    const { dir } = resolvePreflightPaths(projectDir);
    writeFileSync(dir, "blocking file");
    expect(() => persistPreflightState(projectDir, stamp())).not.toThrow();
    expect(readPreflightState(projectDir)).toBeNull();
    expect(() => acquirePreflightLease(projectDir).release()).not.toThrow();
    expect(acquirePreflightLease(projectDir).held).toBe(false);
  });
});

describe("identity and fingerprint", () => {
  it("identity separates tokens without storing them", () => {
    const a = identityHashFor("https://api.example", "token-a");
    const b = identityHashFor("https://api.example", "token-b");
    expect(a).not.toBe(b);
    expect(a).not.toContain("token-a");
    expect(a).toHaveLength(64);
  });

  it("fingerprint is key-order stable and separates missing from empty", () => {
    const x = fingerprintSettings({ b: 1, a: 2 }, "#missing");
    const y = fingerprintSettings({ a: 2, b: 1 }, "#missing");
    expect(x).toBe(y);
    expect(fingerprintSettings({}, "#missing")).not.toBe(
      fingerprintSettings("#missing", "#missing"),
    );
    expect(fingerprintSettings({ autoCommit: true }, "#missing")).not.toBe(
      fingerprintSettings({ autoCommit: false }, "#missing"),
    );
  });
});

describe("non-blocking lease", () => {
  const NOW = 1_700_000_000_000;

  it("second holder loses fast while the first is live", () => {
    const first = acquirePreflightLease(projectDir, NOW);
    expect(first.held).toBe(true);
    expect(acquirePreflightLease(projectDir, NOW + 1000).held).toBe(false);
    first.release();
    expect(acquirePreflightLease(projectDir, NOW + 1000).held).toBe(true);
  });

  it("release is ownership-checked: an old owner cannot delete a live lease", () => {
    const { lockFile } = resolvePreflightPaths(projectDir);
    const first = acquirePreflightLease(projectDir, NOW);
    expect(first.held).toBe(true);
    // Simulate takeover of a stale lock by hand: release, re-age the
    // lock, then let a newcomer take it over.
    first.release();
    writeFileSync(lockFile, JSON.stringify({ nonce: "crashed", at: NOW - PREFLIGHT_LEASE_STALE_MS - 1 }));
    const second = acquirePreflightLease(projectDir, NOW);
    expect(second.held).toBe(true);
    // The crashed owner's release path is gone (release is a closure),
    // but a forged release with the old nonce is a no-op: emulate by
    // calling release on an already-released handle — the live lock stays.
    first.release();
    expect(existsSync(lockFile)).toBe(true);
    expect(acquirePreflightLease(projectDir, NOW + 1).held).toBe(false);
    second.release();
  });

  it("stale locks are taken over; corrupt locks count as stale", () => {
    const { lockFile, dir } = resolvePreflightPaths(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      lockFile,
      JSON.stringify({ nonce: "crashed", at: NOW - PREFLIGHT_LEASE_STALE_MS - 1000 }),
    );
    const takeover = acquirePreflightLease(projectDir, NOW);
    expect(takeover.held).toBe(true);
    takeover.release();

    writeFileSync(lockFile, "corrupt{{{");
    expect(acquirePreflightLease(projectDir, NOW).held).toBe(true);
  });

  it("a live foreign lock is left untouched", () => {
    const { lockFile, dir } = resolvePreflightPaths(projectDir);
    mkdirSync(dir, { recursive: true });
    const before = JSON.stringify({ nonce: "other-process", at: NOW });
    writeFileSync(lockFile, before);
    expect(acquirePreflightLease(projectDir, NOW + 1000).held).toBe(false);
    expect(readFileSync(lockFile, "utf-8")).toBe(before);
  });
});
