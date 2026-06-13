/**
 * Message handlers for the Telegram bot.
 * Uses StatusManager for real-time progress updates during OpenCode processing.
 *
 * Voice handling uses pluggable STT/TTS adapters loaded at runtime.
 * Supports i18n: detects user language and responds in matching locale.
 */

import type TelegramBot from "node-telegram-bot-api";
import type { SessionData } from "./session-manager.js";
import type { STTAdapter, TTSAdapter } from "../types.js";
import type { SupportedLocale } from "../i18n/index.js";
import {
  ocCreateSession,
  ocSendMessage,
  ocAbortSession,
  ocHealth,
  ocListSessions,
  ocDeleteSession as ocDeleteSessionApi,
  ocGetMessages,
  ocListProviders,
  parseModel,
  ocSubscribeEvents,
} from "./opencode-client.js";
import {
  updateSession,
  deleteSession,
  getOrCreateSession,
} from "./session-manager.js";
import { formatForTelegram, splitMessage } from "./format.js";
import { isAllowed, retryAfter } from "./rate-limiter.js";
import { existsSync } from "node:fs";
import { StatusManager } from "./status-manager.js";
import { detectLanguage, mapToSupported, t, LANGUAGE_NAMES } from "../i18n/index.js";

const DEFAULT_MODEL = process.env.TELEGRAM_DEFAULT_MODEL || "opencode-go/mimo-v2.5";

const DEFAULT_MODELS = [
  "opencode-go/mimo-v2.5",
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.7-plus",
  "opencode-go/kimi-k2.6",
  "opencode-go/glm-5.1",
  "opencode-go/minimax-m3",
];

let AVAILABLE_MODELS = [...DEFAULT_MODELS];

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

// ── Status Manager singleton (initialized in initHandlers) ───────────────────

let statusMgr: StatusManager;
let sttAdapter: STTAdapter | null = null;
let ttsAdapter: TTSAdapter | null = null;

/** Per-chat message queue: holds pending messages while OpenCode is busy */
const messageQueue = new Map<string, string[]>();
const MAX_QUEUE_SIZE = 20;

/** Per-chat busy flag: true while processing a request */
const busyChats = new Set<string>();

/**
 * Initialize handlers with bot reference and adapters.
 * Must be called before any handler functions.
 */
export function initHandlers(
  bot: TelegramBot,
  adapters?: { stt?: STTAdapter | null; tts?: TTSAdapter | null },
  options?: { availableModels?: string[] },
): void {
  statusMgr = new StatusManager(bot);
  sttAdapter = adapters?.stt ?? null;
  ttsAdapter = adapters?.tts ?? null;
  if (options?.availableModels) {
    AVAILABLE_MODELS = options.availableModels;
  }

  if (sttAdapter) {
    console.log(`[bridge] STT adapter loaded: ${sttAdapter.name}`);
  }
  if (ttsAdapter) {
    console.log(`[bridge] TTS adapter loaded: ${ttsAdapter.name}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Get or detect locale for a session from text */
function resolveLocale(session: SessionData, text?: string): SupportedLocale {
  if (session.language) return session.language as SupportedLocale;
  if (text) return detectLanguage(text);
  return "en";
}

/** Build the language instruction prefix for OpenCode */
function langPrefix(locale: SupportedLocale): string {
  if (locale === "en") return "";
  const langName = LANGUAGE_NAMES[locale];
  return `[System: Respond in ${langName}.]\n\n`;
}

// ── Text messages ────────────────────────────────────────────────────────────

export interface TextMessageOptions {
  initialStatus?: string;
  skipStatus?: boolean;
}

export async function handleTextMessage(
  msg: TelegramBot.Message,
  bot: TelegramBot,
  chatId: number,
  session: SessionData,
  options?: TextMessageOptions,
): Promise<void> {
  const text = msg.text;
  if (!text) return;

  if (!isAllowed(String(chatId))) {
    const locale = resolveLocale(session);
    await bot.sendMessage(chatId, t("rate_limited", locale, { retryAfter: String(retryAfter(String(chatId))) }));
    return;
  }

  const chatKey = String(chatId);
  if (busyChats.has(chatKey)) {
    const queue = messageQueue.get(chatKey) || [];
    if (queue.length >= MAX_QUEUE_SIZE) {
      const locale = resolveLocale(session);
      await bot.sendMessage(chatId, t("queue_full", locale));
      return;
    }
    queue.push(text);
    messageQueue.set(chatKey, queue);
    const locale = resolveLocale(session);
    await bot.sendMessage(chatId, t("queued", locale, { count: String(queue.length) }), {
      parse_mode: "MarkdownV2",
    });
    return;
  }

  busyChats.add(chatKey);

  // Detect and store language
  const locale = resolveLocale(session, text);
  session.language = locale;
  updateSession(String(chatId), { language: locale });

  const statusId = options?.skipStatus
    ? null
    : await statusMgr.start(chatId, options?.initialStatus ?? t("thinking", locale), locale);

  const sm = statusId
    ? {
        update: (text: string) => statusMgr.update(statusId, text),
        thinking: () => statusMgr.thinking(statusId),
        toolStart: (name: string) => statusMgr.toolStart(statusId, name),
        writing: () => statusMgr.writing(statusId),
        complete: () => statusMgr.complete(statusId),
        cancel: () => statusMgr.cancel(statusId),
        getMessageId: () => statusMgr.getMessageId(statusId),
        updateUsage: (cost: number, tokens: { input: number; output: number }) =>
          statusMgr.updateUsage(statusId, cost, tokens),
        updateToolSummary: (summary: string) =>
          statusMgr.updateToolSummary(statusId, summary),
      }
    : null;

  try {
    if (!session.sessionId) {
      sm?.update(t("creating_session", locale));
      const ocSession = await ocCreateSession(`Telegram ${chatId}`);
      session.sessionId = ocSession.id;
      updateSession(String(chatId), { sessionId: ocSession.id });
    }

    const ac = new AbortController();
    const unsubscribe = ocSubscribeEvents(
      (event) => {
        if (!event.properties) return;
        if (event.type === "sync" || event.type === "server.heartbeat" || event.type === "server.connected") return;

        if (event.type === "session.updated") {
          const info = event.properties.info as Record<string, unknown> | undefined;
          if (info) {
            const cost = (info.cost as number) || 0;
            const tokens = info.tokens as { input?: number; output?: number } | undefined;
            if (cost > 0 || (tokens && (tokens.input || tokens.output))) {
              sm?.updateUsage(cost, {
                input: tokens?.input || 0,
                output: tokens?.output || 0,
              });
            }
          }
        } else if (event.type === "session.status") {
          const status = event.properties.status as Record<string, unknown> | string | undefined;
          const statusType = typeof status === "object" ? status?.type : status;
          if (statusType === "busy") {
            sm?.thinking();
          }
        } else if (event.type === "message.part.updated") {
          const part = event.properties.part as Record<string, unknown> | undefined;
          if (!part) return;
          const partType = part.type as string | undefined;

          if (partType === "tool-call") {
            const toolName = (part.name as string) || (part.tool as string) || "tool";
            sm?.toolStart(toolName);
            const input = part.input;
            if (typeof input === "string") {
              const summary = truncate(input.replace(/\n/g, " ").trim(), 60);
              if (summary) sm?.updateToolSummary(summary);
            } else if (input && typeof input === "object") {
              const keys = Object.keys(input).slice(0, 3).join(", ");
              if (keys) sm?.updateToolSummary(keys);
            }
          } else if (partType === "step-finish") {
            const cost = (part.cost as number) || 0;
            const tokens = part.tokens as Record<string, unknown> | undefined;
            if (cost > 0 || tokens) {
              sm?.updateUsage(cost, {
                input: (tokens?.input as number) || 0,
                output: (tokens?.output as number) || 0,
              });
            }
          } else if (partType === "text" || partType === "reasoning") {
            sm?.writing();
          }
        } else if (event.type === "message.part.delta") {
          const field = event.properties.field as string | undefined;
          if (field === "text") {
            sm?.writing();
          }
        }
      },
      { sessionID: session.sessionId, signal: ac.signal },
    );

    // Prepend language instruction for non-English locales
    const prompt = langPrefix(locale) + text;

    let response;
    try {
      sm?.thinking();
      response = await ocSendMessage(session.sessionId, parseModel(session.model), prompt);
    } catch (err) {
      if ((err as Error).message.includes("Session not found")) {
        sm?.update(t("session_expired", locale));
        const ocSession = await ocCreateSession(`Telegram ${chatId}`);
        session.sessionId = ocSession.id;
        updateSession(String(chatId), { sessionId: ocSession.id });
        sm?.thinking();
        response = await ocSendMessage(session.sessionId, parseModel(session.model), prompt);
      } else {
        throw err;
      }
    }

    unsubscribe();
    ac.abort();

    const responseText = response.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text || "")
      .join("\n");

    const toolNames = response.parts
      .filter((p) => p.type === "tool")
      .map((p) => {
        if (typeof p.tool === "string") return p.tool;
        if (p.tool && typeof p.tool === "object" && "name" in p.tool) return (p.tool as { name: string }).name;
        return "unknown";
      });

    if (!responseText && toolNames.length === 0) {
      sm?.complete();
      await bot.sendMessage(chatId, t("no_response", locale));
      return;
    }

    let reply = responseText || "";
    if (toolNames.length > 0) {
      const summary = toolNames.map((n) => `🔧 \`${n}\``).join(", ");
      reply = reply ? `${reply}\n\n${summary}` : summary;
    }

    // Check for audio file in response and send as voice if present
    const audioResult = extractAudioFromText(reply);
    if (audioResult) {
      const statusMsgId = sm?.getMessageId();
      if (statusMsgId) {
        await bot.deleteMessage(chatId, statusMsgId).catch(() => {});
      }
      await bot.sendVoice(chatId, audioResult.audioPath);
      if (audioResult.remainingText) {
        reply = audioResult.remainingText;
      } else {
        sm?.complete();
        return;
      }
    }

    const statusMsgId = sm?.getMessageId();
    sm?.complete();

    const chunks = splitMessage(formatForTelegram(reply));

    if (statusMsgId) {
      try {
        await bot.editMessageText(chunks[0], {
          chat_id: chatId,
          message_id: statusMsgId,
          parse_mode: "MarkdownV2",
        });
        for (let i = 1; i < chunks.length; i++) {
          await bot.sendMessage(chatId, chunks[i], { parse_mode: "MarkdownV2" });
        }
      } catch {
        await bot.deleteMessage(chatId, statusMsgId).catch(() => {});
        try {
          for (const chunk of chunks) {
            await bot.sendMessage(chatId, chunk, { parse_mode: "MarkdownV2" });
          }
        } catch {
          const plainChunks = splitMessage(reply);
          for (const chunk of plainChunks) {
            await bot.sendMessage(chatId, chunk);
          }
        }
      }
    } else {
      try {
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, chunk, { parse_mode: "MarkdownV2" });
        }
      } catch {
        const plainChunks = splitMessage(reply);
        for (const chunk of plainChunks) {
          await bot.sendMessage(chatId, chunk);
        }
      }
    }

    busyChats.delete(chatKey);
    const nextMsg = messageQueue.get(chatKey)?.shift();
    if (nextMsg) {
      const fakeMsg = { ...msg, text: nextMsg };
      handleTextMessage(fakeMsg, bot, chatId, session).catch(() => {});
    } else {
      messageQueue.delete(chatKey);
    }
  } catch (e) {
    sm?.cancel();
    busyChats.delete(chatKey);
    const nextMsg = messageQueue.get(chatKey)?.shift();
    if (nextMsg) {
      const fakeMsg = { ...msg, text: nextMsg };
      handleTextMessage(fakeMsg, bot, chatId, session).catch(() => {});
    } else {
      messageQueue.delete(chatKey);
    }
    throw e;
  }
}

// ── Voice messages ───────────────────────────────────────────────────────────

export async function handleVoiceMessage(
  msg: TelegramBot.Message,
  bot: TelegramBot,
  chatId: number,
  session: SessionData,
): Promise<void> {
  const voice = msg.voice;
  if (!voice) return;

  if (!isAllowed(String(chatId))) {
    const locale = resolveLocale(session);
    await bot.sendMessage(chatId, t("rate_limited", locale, { retryAfter: String(retryAfter(String(chatId))) }));
    return;
  }

  if (!sttAdapter) {
    const locale = resolveLocale(session);
    await bot.sendMessage(chatId, t("voice_not_configured", locale));
    return;
  }

  const locale = resolveLocale(session);
  const statusId = await statusMgr.start(chatId, t("transcribing", locale), locale);

  try {
    const fileInfo = await fetchTelegramFile(voice.file_id);
    const fileBuffer = await downloadTelegramFile(fileInfo.file_path);
    const sttResult = await sttAdapter.transcribe(fileBuffer, voice.mime_type || "audio/ogg");

    if (!sttResult.text || sttResult.text.trim().length === 0) {
      statusMgr.complete(statusId);
      await bot.sendMessage(chatId, t("voice_no_text", locale));
      return;
    }

    // Use STT-detected language if available
    if (sttResult.language) {
      const sttLocale = mapToSupported(sttResult.language);
      session.language = sttLocale;
      updateSession(String(chatId), { language: sttLocale });
    }

    statusMgr.complete(statusId);

    const emotionPrefix =
      sttResult.emotion && sttResult.emotion !== "neutral"
        ? t("voice_emotion_prefix", locale, { emotion: sttResult.emotion })
        : t("voice_prefix", locale);

    const fakeMsg = { ...msg, text: `${emotionPrefix} ${sttResult.text}` };
    await handleTextMessage(fakeMsg, bot, chatId, session, { skipStatus: true });
  } catch (e) {
    await statusMgr.cancel(statusId);
    await bot.sendMessage(chatId, t("voice_failed", locale, { error: sanitizeError(e) }));
  }
}

// ── Photo messages (receipts) ────────────────────────────────────────────────

export async function handlePhotoMessage(
  msg: TelegramBot.Message,
  bot: TelegramBot,
  chatId: number,
  session: SessionData,
): Promise<void> {
  const photos = msg.photo;
  if (!photos || photos.length === 0) return;

  if (!isAllowed(String(chatId))) {
    const locale = resolveLocale(session);
    await bot.sendMessage(chatId, t("rate_limited", locale, { retryAfter: String(retryAfter(String(chatId))) }));
    return;
  }

  const locale = resolveLocale(session);
  const photo = photos[photos.length - 1];
  await bot.sendChatAction(chatId, "typing");

  try {
    const fileInfo = await fetchTelegramFile(photo.file_id);
    const fileBuffer = await downloadTelegramFile(fileInfo.file_path);

    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const receiptDir = join(tmpdir(), "opencode-telegram-files");
    mkdirSync(receiptDir, { recursive: true });
    const receiptPath = join(receiptDir, `receipt-${Date.now()}.jpg`);
    writeFileSync(receiptPath, fileBuffer);

    const caption = msg.caption || "";
    const prompt = `Please process this receipt photo saved at ${receiptPath}. ${caption ? `User note: ${caption}` : "Extract the receipt details and add it to the finance database."}`;

    const fakeMsg = { ...msg, text: prompt };
    await handleTextMessage(fakeMsg, bot, chatId, session);
  } catch (e) {
    await bot.sendMessage(chatId, t("receipt_failed", locale, { error: sanitizeError(e) }));
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

function relativeTime(dateStr?: string): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function sanitizeError(err: unknown): string {
  const msg = (err as Error).message || "Unknown error";
  return msg
    .replace(/https?:\/\/[^\s]+/g, "[redacted-url]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "[redacted-token]")
    .replace(/\/[a-zA-Z0-9_/.-]+\.(ts|js|json)/g, "[internal-file]")
    .replace(/localhost:\d+/g, "[internal-service]")
    .slice(0, 200);
}

function extractAudioFromText(text: string): { audioPath: string; remainingText: string } | null {
  const audioPathRegex = /(?:[🎙️🔊🎵🎤]*\s*(?:Audio:\s*)?)?([^\s"'`]+\.(?:mp3|ogg|wav))/i;
  const match = text.match(audioPathRegex);

  if (!match) return null;

  const audioPath = match[1];
  if (!existsSync(audioPath)) return null;

  const remainingText = text
    .split("\n")
    .filter((line) => !line.includes(audioPath))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { audioPath, remainingText };
}

export async function handleCommand(
  msg: TelegramBot.Message,
  bot: TelegramBot,
  chatId: number,
  session: SessionData,
): Promise<void> {
  const [command, ...args] = (msg.text || "").split(" ");
  const locale = resolveLocale(session);

  switch (command) {
    case "/start":
    case "/help":
      await bot.sendMessage(
        chatId,
        formatForTelegram(t("start_help", locale)),
        { parse_mode: "MarkdownV2" },
      );
      break;

    case "/new":
      deleteSession(String(chatId));
      getOrCreateSession(String(chatId), DEFAULT_MODEL);
      await bot.sendMessage(chatId, t("new_session", locale));
      break;

    case "/stop":
      if (session.sessionId) {
        try {
          await ocAbortSession(session.sessionId);
          await bot.sendMessage(chatId, t("stop_cancelled", locale));
        } catch {
          await bot.sendMessage(chatId, t("nothing_to_cancel", locale));
        }
      } else {
        await bot.sendMessage(chatId, t("nothing_to_cancel", locale));
      }
      break;

    case "/model":
      if (args.length > 0) {
        const model = args[0];
        if (!AVAILABLE_MODELS.includes(model)) {
          await bot.sendMessage(chatId, t("model_unknown", locale, { model: truncate(model, 30) }), {
            parse_mode: "MarkdownV2",
          });
          return;
        }
        updateSession(String(chatId), { model });
        await bot.sendMessage(chatId, t("model_changed", locale, { model }));
      } else {
        const keyboard = AVAILABLE_MODELS.map((m) => [{ text: m, callback_data: `model:${m}` }]);
        await bot.sendMessage(chatId, t("model_select", locale), {
          reply_markup: { inline_keyboard: keyboard },
        });
      }
      break;

    case "/status": {
      const health = await ocHealth();
      const status = health.connected
        ? t("status_connected", locale)
        : t("status_disconnected", locale);
      const voiceStatus = sttAdapter ? `STT: ${sttAdapter.name}` : t("stt_not_configured", locale);
      await bot.sendMessage(
        chatId,
        formatForTelegram(t("status_format", locale, { status, model: session.model, voice: voiceStatus })),
        { parse_mode: "MarkdownV2" },
      );
      break;
    }

    case "/sessions": {
      await bot.sendChatAction(chatId, "typing");
      try {
        const sessions = await ocListSessions();
        if (!sessions || sessions.length === 0) {
          await bot.sendMessage(chatId, t("sessions_none", locale));
          return;
        }

        const sorted = sessions
          .sort((a, b) => {
            const ta = a.updatedAt || a.createdAt || "";
            const tb = b.updatedAt || b.createdAt || "";
            return tb.localeCompare(ta);
          })
          .slice(0, 10);

        const keyboard = sorted.map((s) => {
          const isCurrent = s.id === session.sessionId;
          const prefix = isCurrent ? "✅ " : "";
          const title = truncate(s.title || "Untitled", 25);
          const time = relativeTime(s.updatedAt || s.createdAt);
          const label = `${prefix}${title}${time ? ` (${time})` : ""}`;
          return [{ text: label, callback_data: `switch:${s.id}` }];
        });

        await bot.sendMessage(chatId, t("sessions_list", locale), {
          parse_mode: "MarkdownV2",
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch (e) {
        await bot.sendMessage(chatId, t("sessions_error", locale, { error: sanitizeError(e) }));
      }
      break;
    }

    case "/switch": {
      if (args.length > 0) {
        const targetId = args[0];
        try {
          const sessions = await ocListSessions();
          const exists = sessions?.some((s) => s.id === targetId);
          if (!exists) {
            await bot.sendMessage(chatId, t("switch_not_found", locale));
            return;
          }
          updateSession(String(chatId), { sessionId: targetId });
          await bot.sendMessage(chatId, t("switch_success", locale, { id: truncate(targetId, 30) }), {
            parse_mode: "MarkdownV2",
          });
        } catch (e) {
          await bot.sendMessage(chatId, t("switch_error", locale, { error: sanitizeError(e) }));
        }
      } else {
        await bot.sendChatAction(chatId, "typing");
        try {
          const sessions = await ocListSessions();
          if (!sessions || sessions.length === 0) {
            await bot.sendMessage(chatId, t("switch_no_sessions", locale));
            return;
          }
          const sorted = sessions
            .sort((a, b) => {
              const ta = a.updatedAt || a.createdAt || "";
              const tb = b.updatedAt || b.createdAt || "";
              return tb.localeCompare(ta);
            })
            .slice(0, 10);

          const keyboard = sorted.map((s) => {
            const isCurrent = s.id === session.sessionId;
            const prefix = isCurrent ? "✅ " : "";
            const title = truncate(s.title || "Untitled", 25);
            const time = relativeTime(s.updatedAt || s.createdAt);
            const label = `${prefix}${title}${time ? ` (${time})` : ""}`;
            return [{ text: label, callback_data: `switch:${s.id}` }];
          });

          await bot.sendMessage(chatId, t("switch_select", locale), {
            parse_mode: "MarkdownV2",
            reply_markup: { inline_keyboard: keyboard },
          });
        } catch (e) {
          await bot.sendMessage(chatId, t("switch_list_error", locale, { error: sanitizeError(e) }));
        }
      }
      break;
    }

    case "/delete": {
      if (!session.sessionId) {
        await bot.sendMessage(chatId, t("delete_none", locale));
        return;
      }
      try {
        await ocDeleteSessionApi(session.sessionId);
        deleteSession(String(chatId));
        getOrCreateSession(String(chatId), DEFAULT_MODEL);
        await bot.sendMessage(chatId, t("delete_success", locale));
      } catch {
        deleteSession(String(chatId));
        getOrCreateSession(String(chatId), DEFAULT_MODEL);
        await bot.sendMessage(chatId, t("delete_local", locale));
      }
      break;
    }

    case "/history": {
      if (!session.sessionId) {
        await bot.sendMessage(chatId, t("history_none_session", locale));
        return;
      }
      await bot.sendChatAction(chatId, "typing");
      try {
        const messages = await ocGetMessages(session.sessionId);
        if (!messages || messages.length === 0) {
          await bot.sendMessage(chatId, t("history_none_messages", locale));
          return;
        }

        const recent = messages.slice(-5);
        const lines = recent.map((m) => {
          const role = m.info.role === "user" ? t("history_you", locale) : t("history_assistant", locale);
          const textPart = m.parts?.find((p) => p.type === "text");
          const text = textPart?.text || t("history_no_text", locale);
          return `${role}: ${truncate(text, 200)}`;
        });

        const reply = lines.join("\n\n");
        await bot.sendMessage(chatId, formatForTelegram(reply), { parse_mode: "MarkdownV2" });
      } catch (e) {
        await bot.sendMessage(chatId, t("history_error", locale, { error: sanitizeError(e) }));
      }
      break;
    }

    case "/providers": {
      await bot.sendChatAction(chatId, "typing");
      try {
        const providers = await ocListProviders();
        if (!providers || providers.length === 0) {
          await bot.sendMessage(chatId, t("providers_none", locale));
          return;
        }

        const lines = providers.map((p) => {
          const name = p.name || p.id;
          const models = p.models?.map((m) => `  • ${m.name || m.id}`).join("\n") || `  ${t("providers_no_models", locale)}`;
          return `*${name}*\n${models}`;
        });

        const reply = lines.join("\n\n");
        const chunks = splitMessage(formatForTelegram(reply));
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, chunk, { parse_mode: "MarkdownV2" });
        }
      } catch (e) {
        await bot.sendMessage(chatId, t("providers_error", locale, { error: sanitizeError(e) }));
      }
      break;
    }

    default:
      await bot.sendMessage(chatId, t("unknown_command", locale, { command }));
  }
}

// ── Callback query (inline keyboard) ────────────────────────────────────────

export async function handleCallbackQuery(
  query: TelegramBot.CallbackQuery,
  bot: TelegramBot,
): Promise<void> {
  const data = query.data || "";
  const chatId = query.message?.chat.id;
  if (!chatId) return;

  const session = getOrCreateSession(String(chatId), DEFAULT_MODEL);
  const locale = (session.language as SupportedLocale) ?? "en";

  if (data.startsWith("model:")) {
    const model = data.slice(6);
    if (AVAILABLE_MODELS.includes(model)) {
      updateSession(String(chatId), { model });
      await bot.answerCallbackQuery(query.id, { text: t("model_changed", locale, { model }) });
      await bot.sendMessage(chatId, t("model_changed", locale, { model }));
    }
  } else if (data.startsWith("switch:")) {
    const sessionId = data.slice(7);
    updateSession(String(chatId), { sessionId });
    await bot.answerCallbackQuery(query.id, { text: t("switch_callback", locale) });
    await bot.sendMessage(chatId, t("switch_success", locale, { id: truncate(sessionId, 30) }), {
      parse_mode: "MarkdownV2",
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchTelegramFile(fileId: string): Promise<{ file_path: string }> {
  const res = await fetch(
    `https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  const data = await res.json();
  if (!data.ok) throw new Error("getFile failed");
  return data.result;
}

async function downloadTelegramFile(filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
