/**
 * Session manager — maps Telegram chatId to OpenCode session ID and model.
 * Storage: configurable directory via SESSIONS_DIR env (default: os.tmpdir()/opencode-telegram/sessions)
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const SESSIONS_DIR = process.env.SESSIONS_DIR || join(tmpdir(), "opencode-telegram", "sessions");
const SESSIONS_FILE = join(SESSIONS_DIR, "sessions.json");
const DEBUG = process.env.DEBUG_BRIDGE === "true" || process.env.DEBUG === "true";

function logDebug(msg: string, ...args: unknown[]): void {
  if (DEBUG) console.log(`[session:debug] ${msg}`, ...args);
}

function logInfo(msg: string, ...args: unknown[]): void {
  console.log(`[session:info] ${msg}`, ...args);
}

function logError(msg: string, ...args: unknown[]): void {
  console.error(`[session:error] ${msg}`, ...args);
}

export interface SessionData {
  sessionId: string;
  model: string;
  createdAt: string;
  /** Detected user language locale (en/de/hr) — updated on each message */
  language?: string;
  /** User-selected voice language preference (auto/en/de/hr) — skips auto-detection when set */
  voiceLanguage?: string;
}

/** Validate chatId — must be a numeric string (Telegram chat IDs are numeric) */
function isValidChatId(chatId: string): boolean {
  return /^\d+$/.test(chatId);
}

function load(): Record<string, SessionData> {
  try {
    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logError("Sessions file is not an object, resetting");
      return {};
    }
    logDebug(`load: loaded ${Object.keys(parsed).length} sessions`);
    return parsed;
  } catch {
    logDebug("load: no sessions file found, starting fresh");
    return {};
  }
}

function save(store: Record<string, SessionData>): void {
  try {
    mkdirSync(dirname(SESSIONS_FILE), { recursive: true });
    const tmp = SESSIONS_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, SESSIONS_FILE);
    logDebug(`save: saved ${Object.keys(store).length} sessions`);
  } catch (err) {
    logError(`save: failed to save sessions - ${(err as Error).message}`);
  }
}

export function getOrCreateSession(chatId: string, defaultModel: string): SessionData {
  if (!isValidChatId(chatId)) {
    logError(`getOrCreateSession: invalid chatId="${chatId}"`);
    throw new Error("Invalid chatId: must be numeric");
  }
  const store = load();
  if (store[chatId]) {
    logDebug(`getOrCreateSession: found existing session for chat=${chatId}, model=${store[chatId].model}`);
    return store[chatId];
  }

  const session: SessionData = {
    sessionId: "",
    model: defaultModel,
    createdAt: new Date().toISOString(),
  };
  store[chatId] = session;
  save(store);
  logInfo(`getOrCreateSession: created new session for chat=${chatId}, model=${defaultModel}`);
  return session;
}

export function updateSession(chatId: string, fields: Partial<SessionData>): void {
  if (!isValidChatId(chatId)) {
    logError(`updateSession: invalid chatId="${chatId}"`);
    return;
  }
  const store = load();
  if (!store[chatId]) {
    logError(`updateSession: session not found for chat=${chatId}`);
    return;
  }
  store[chatId] = { ...store[chatId], ...fields };
  save(store);
  logDebug(`updateSession: updated session for chat=${chatId}, fields=${Object.keys(fields).join(",")}`);
}

export function deleteSession(chatId: string): void {
  if (!isValidChatId(chatId)) {
    logError(`deleteSession: invalid chatId="${chatId}"`);
    return;
  }
  const store = load();
  if (store[chatId]) {
    logInfo(`deleteSession: deleted session for chat=${chatId}`);
  }
  delete store[chatId];
  save(store);
}
