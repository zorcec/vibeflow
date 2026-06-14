/**
 * Core bot logic — programmatic API for creating and starting the bot.
 *
 * Usage:
 *   import { createBot } from 'opencode-telegram-bridge';
 *   const bot = await createBot({ token: '...', opencodeUrl: '...' });
 */

import TelegramBot from "node-telegram-bot-api";
import http from "node:http";
import type { BridgeConfig, STTAdapter, TTSAdapter } from "./types.js";
import { resolveAdapters } from "./adapter-loader.js";
import {
  handleTextMessage,
  handleVoiceMessage,
  handlePhotoMessage,
  handleCommand,
  handleCallbackQuery,
  initHandlers,
  shutdownHandlers,
} from "./telegram/handlers.js";
import { getOrCreateSession } from "./telegram/session-manager.js";
import { ocHealth } from "./telegram/opencode-client.js";
import { t } from "./i18n/index.js";

export interface BotInstance {
  bot: TelegramBot;
  stop: () => void;
}

/**
 * Create and start the Telegram bot.
 *
 * @param config - Bot configuration
 * @returns BotInstance with bot reference and stop function
 */
export async function createBot(config: BridgeConfig): Promise<BotInstance> {
  const {
    token,
    opencodeUrl = process.env.OPENCODE_URL || "http://localhost:4096",
    allowedUsers = process.env.TELEGRAM_ALLOWED_USERS || "",
    defaultModel = process.env.TELEGRAM_DEFAULT_MODEL || "opencode-go/mimo-v2.5",
    port: portConfig,
  } = config;

  const portRaw = portConfig ?? parseInt(process.env.PORT || "3001", 10);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 3001;

  // Resolve STT/TTS adapters (programmatic > env > built-in defaults)
  const adapters = await resolveAdapters({
    stt: config.stt,
    tts: config.tts,
  });

  // NOTE: We intentionally do NOT mutate process.env.OPENCODE_URL here.
  // The opencode-client module reads it at import time. If you need to
  // override it, set the env var before calling createBot().

  const allowedUserIds = allowedUsers
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  // Initialize bot
  const bot = new TelegramBot(token, { polling: true });

  // Initialize handlers with adapters
  initHandlers(bot, adapters, { availableModels: config.availableModels });

  console.log(
    `[bridge] Bot starting — ${allowedUserIds.length > 0 ? `${allowedUserIds.length} users allowed` : "open to all"} model=${defaultModel}`,
  );

  // Register commands for autocomplete
  await bot.setMyCommands([
    { command: "start", description: "Welcome message and help" },
    { command: "new", description: "Start a fresh conversation" },
    { command: "stop", description: "Cancel running request" },
    { command: "model", description: "Switch AI model" },
    { command: "lang", description: "Set voice language" },
    { command: "sessions", description: "List all conversations" },
    { command: "switch", description: "Switch to a conversation" },
    { command: "delete", description: "Delete current conversation" },
    { command: "history", description: "Show recent messages" },
    { command: "providers", description: "List AI providers" },
    { command: "status", description: "Check connection" },
    { command: "help", description: "Show available commands" },
  ]).catch((err) => {
    console.error("[bridge] Failed to register commands:", (err as Error).message);
  });

  // Auth middleware
  function isAuthorized(userId: number): boolean {
    if (allowedUserIds.length === 0) return true;
    return allowedUserIds.includes(String(userId));
  }

  // Message routing
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    const session = getOrCreateSession(String(chatId), defaultModel);

    if (userId && !isAuthorized(userId)) {
      const locale = (session.language as "en" | "de" | "hr") ?? "en";
      await bot.sendMessage(chatId, t("access_denied", locale));
      return;
    }

    try {
      if (msg.text?.startsWith("/")) {
        await handleCommand(msg, bot, chatId, session);
      } else if (msg.voice || msg.audio) {
        await handleVoiceMessage(msg, bot, chatId, session);
      } else if (msg.photo && msg.photo.length > 0) {
        await handlePhotoMessage(msg, bot, chatId, session);
      } else if (msg.text) {
        await handleTextMessage(msg, bot, chatId, session);
      }
    } catch (e) {
      const err = e as Error & { code?: string; cause?: unknown };
      console.error(`[bridge] Error handling message from ${chatId}:`);
      console.error(`[bridge]   error: ${err.message}`);
      if (err.code) console.error(`[bridge]   code: ${err.code}`);
      if (err.cause) {
        const cause = err.cause as Error & { code?: string; syscall?: string };
        console.error(`[bridge]   cause: ${cause.message || cause}`);
        if (cause.code) console.error(`[bridge]   cause.code: ${cause.code}`);
        if (cause.syscall) console.error(`[bridge]   cause.syscall: ${cause.syscall}`);
      }
      const safeMsg = ((e as Error).message || "Unknown error")
        .replace(/https?:\/\/[^\s]+/g, "[redacted]")
        .replace(/bot\d+:[A-Za-z0-9_-]+/g, "[redacted]")
        .slice(0, 200);
      const locale = (session.language as "en" | "de" | "hr") ?? "en";
      await bot.sendMessage(chatId, t("error_prefix", locale, { message: safeMsg }));
    }
  });

  // Callback queries (inline keyboard)
  bot.on("callback_query", async (query) => {
    try {
      await handleCallbackQuery(query, bot);
    } catch (e) {
      console.error("[bridge] Callback query error:", (e as Error).message);
    }
  });

  // Health endpoint
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      const health = await ocHealth();
      const status = health.connected ? 200 : 503;
      res.writeHead(status, { "Content-Type": "application/json" });
      // Don't expose version — just connection status
      res.end(JSON.stringify({ status: health.connected ? "ok" : "degraded" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`[bridge] Health endpoint ready on port ${port}`);
  });

  // Graceful shutdown — only call process.exit for real signals, not for stop()
  async function cleanup() {
    await shutdownHandlers();
    bot.stopPolling();
    server.close();
  }

  function shutdown(signal: string) {
    console.log(`[bridge] Shutting down (${signal})`);
    cleanup().then(() => process.exit(0)).catch(() => process.exit(1));
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("[bridge] Bot ready — press Ctrl+C to stop");

  // Send startup message to all allowed users
  if (allowedUserIds.length > 0) {
    const startupMsg = t("bot_startup", "en");
    for (const userId of allowedUserIds) {
      bot.sendMessage(parseInt(userId), startupMsg, { parse_mode: "MarkdownV2" })
        .catch((err) => {
          console.error(`[bridge] Failed to send startup message to ${userId}:`, (err as Error).message);
        });
    }
  }

  return {
    bot,
    stop: () => {
      cleanup().catch(() => {});
    },
  };
}
