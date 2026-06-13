/**
 * Session manager — maps Telegram chatId to OpenCode session ID and model.
 * Storage: configurable directory via SESSIONS_DIR env (default: os.tmpdir()/opencode-telegram/sessions)
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const SESSIONS_DIR = process.env.SESSIONS_DIR || join(tmpdir(), "opencode-telegram", "sessions");
const SESSIONS_FILE = join(SESSIONS_DIR, "sessions.json");

export interface SessionData {
  sessionId: string;
  model: string;
  createdAt: string;
  /** Detected user language locale (en/de/hr) — updated on each message */
  language?: string;
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
      console.error("[bridge] Sessions file is not an object, resetting");
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function save(store: Record<string, SessionData>): void {
  mkdirSync(dirname(SESSIONS_FILE), { recursive: true });
  const tmp = SESSIONS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, SESSIONS_FILE);
}

export function getOrCreateSession(chatId: string, defaultModel: string): SessionData {
  if (!isValidChatId(chatId)) {
    throw new Error("Invalid chatId: must be numeric");
  }
  const store = load();
  if (store[chatId]) return store[chatId];

  const session: SessionData = {
    sessionId: "",
    model: defaultModel,
    createdAt: new Date().toISOString(),
  };
  store[chatId] = session;
  save(store);
  return session;
}

export function updateSession(chatId: string, fields: Partial<SessionData>): void {
  if (!isValidChatId(chatId)) return;
  const store = load();
  if (!store[chatId]) return;
  store[chatId] = { ...store[chatId], ...fields };
  save(store);
}

export function deleteSession(chatId: string): void {
  if (!isValidChatId(chatId)) return;
  const store = load();
  delete store[chatId];
  save(store);
}
