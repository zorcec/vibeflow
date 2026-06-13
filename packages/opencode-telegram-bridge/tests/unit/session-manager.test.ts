import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to test session manager with a custom SESSIONS_DIR
// Since it reads env at import time, we set it before import
const TEST_SESSIONS_DIR = join(tmpdir(), "test-sessions-" + Date.now());

describe("session-manager", () => {
  beforeEach(() => {
    mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
    // Set env before dynamic import
    process.env.SESSIONS_DIR = TEST_SESSIONS_DIR;
  });

  afterEach(() => {
    rmSync(TEST_SESSIONS_DIR, { recursive: true, force: true });
    delete process.env.SESSIONS_DIR;
  });

  // Dynamic import to pick up env changes
  async function getModules() {
    const mod = await import("../../src/telegram/session-manager.js");
    return mod;
  }

  it("creates a new session", async () => {
    const { getOrCreateSession } = await getModules();
    const session = getOrCreateSession("100001", "default-model");
    expect(session.sessionId).toBe("");
    expect(session.model).toBe("default-model");
    expect(session.createdAt).toBeDefined();
  });

  it("returns existing session on second call", async () => {
    const { getOrCreateSession } = await getModules();
    const session1 = getOrCreateSession("100002", "model-a");
    const session2 = getOrCreateSession("100002", "model-b");
    // They should be equal but not the same object reference (loaded from disk each time)
    expect(session1).toStrictEqual(session2);
  });

  it("updates session fields", async () => {
    const { getOrCreateSession, updateSession } = await getModules();
    getOrCreateSession("100003", "model-x");
    updateSession("100003", { sessionId: "session-123" });

    const { getOrCreateSession: get2 } = await getModules();
    const session = get2("100003", "model-x");
    expect(session.sessionId).toBe("session-123");
  });

  it("deletes session", async () => {
    const { getOrCreateSession, deleteSession } = await getModules();
    getOrCreateSession("100004", "model-y");
    deleteSession("100004");

    const { getOrCreateSession: get2 } = await getModules();
    const session = get2("100004", "model-z");
    expect(session.sessionId).toBe("");
    expect(session.model).toBe("model-z");
  });

  it("persists to sessions.json file", async () => {
    const { getOrCreateSession } = await getModules();
    getOrCreateSession("100005", "model-persist");

    const sessionsFile = join(TEST_SESSIONS_DIR, "sessions.json");
    expect(existsSync(sessionsFile)).toBe(true);

    const data = JSON.parse(readFileSync(sessionsFile, "utf-8"));
    expect(data["100005"]).toBeDefined();
    expect(data["100005"].model).toBe("model-persist");
  });

  it("handles corrupted sessions file gracefully", async () => {
    const sessionsFile = join(TEST_SESSIONS_DIR, "sessions.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(sessionsFile, "not valid json {{{");

    const { getOrCreateSession } = await getModules();
    const session = getOrCreateSession("100006", "fallback-model");
    expect(session.model).toBe("fallback-model");
  });

  it("rejects non-numeric chatId", async () => {
    const { getOrCreateSession } = await getModules();
    expect(() => getOrCreateSession("not-a-number", "model")).toThrow("Invalid chatId");
  });

  it("resets when sessions file contains an array", async () => {
    const sessionsFile = join(TEST_SESSIONS_DIR, "sessions.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(sessionsFile, "[]");

    const { getOrCreateSession } = await getModules();
    const session = getOrCreateSession("100007", "fallback-model");
    expect(session.model).toBe("fallback-model");
  });

  it("resets when sessions file contains null", async () => {
    const sessionsFile = join(TEST_SESSIONS_DIR, "sessions.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(sessionsFile, "null");

    const { getOrCreateSession } = await getModules();
    const session = getOrCreateSession("100008", "fallback-model");
    expect(session.model).toBe("fallback-model");
  });

  it("resets when sessions file contains a string", async () => {
    const sessionsFile = join(TEST_SESSIONS_DIR, "sessions.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(sessionsFile, "\"hello\"");

    const { getOrCreateSession } = await getModules();
    const session = getOrCreateSession("100009", "fallback-model");
    expect(session.model).toBe("fallback-model");
  });

  it("uses atomic write (tmp + rename)", async () => {
    const { getOrCreateSession } = await getModules();
    getOrCreateSession("100010", "model-atomic");

    const { existsSync } = await import("node:fs");
    // Main file should exist
    expect(existsSync(join(TEST_SESSIONS_DIR, "sessions.json"))).toBe(true);
    // Temp file should NOT exist after successful write
    expect(existsSync(join(TEST_SESSIONS_DIR, "sessions.json.tmp"))).toBe(false);
  });
});
