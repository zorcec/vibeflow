/**
 * OpenCode Telegram Bridge
 *
 * Standalone Telegram bot bridge for OpenCode.
 * Plug any STT/TTS adapter via dynamic import.
 *
 * @example
 * ```ts
 * import { createBot } from 'opencode-telegram-bridge';
 *
 * const bot = await createBot({
 *   token: process.env.TELEGRAM_BOT_TOKEN,
 *   opencodeUrl: 'http://localhost:4096',
 * });
 * ```
 */

// Core API
export { createBot } from "./bot.js";
export type { BotInstance } from "./bot.js";

// Adapter system
export { loadSTT, loadTTS, resolveAdapters } from "./adapter-loader.js";
export type { ResolvedAdapters } from "./adapter-loader.js";

// Types
export type {
  STTAdapter,
  STTResult,
  TTSAdapter,
  TTSOptions,
  TTSResult,
  STTAdapterModule,
  TTSAdapterModule,
  BridgeConfig,
} from "./types.js";

// Built-in adapters (for direct use)
export { SenseVoiceSTTAdapter } from "./adapters/sensevoice-stt.js";
export { EdgeTTSAdapter } from "./adapters/edge-tts.js";

// i18n
export { detectLanguage, mapToSupported, t, toolName, SUPPORTED_LOCALES, LANGUAGE_NAMES } from "./i18n/index.js";
export type { SupportedLocale, LocaleKeys } from "./i18n/index.js";

// URL validation
export { validateUrl } from "./validate-url.js";
