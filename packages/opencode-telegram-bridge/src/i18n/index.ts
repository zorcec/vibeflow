/**
 * i18n — language detection and translation for the Telegram bot.
 *
 * Detects the user's input language (text or voice) and provides
 * translated UI strings via `t(key, locale)`. Falls back to English
 * for unsupported languages.
 *
 * Supported response locales: en, de, hr
 * Detection: any language via tinyld (96 languages)
 *
 * To add a new language:
 *   1. Copy src/i18n/locales/en.ts → src/i18n/locales/{code}.ts
 *   2. Translate all values (keep keys identical)
 *   3. Add the code to SUPPORTED_LOCALES in this file
 *   4. Import and add to LOCALES map
 *   5. Add a language name to LANGUAGE_NAMES
 *   6. Add any related language mappings to LANGUAGE_MAP
 */

import { detect, toISO2 } from "tinyld";
import en, { type LocaleKeys } from "./locales/en.js";
import de from "./locales/de.js";
import hr from "./locales/hr.js";

// ── Supported locales ──────────────────────────────────────────────────────

export const SUPPORTED_LOCALES = ["en", "de", "hr"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// ── Locale registry ────────────────────────────────────────────────────────

const LOCALES: Record<SupportedLocale, Record<LocaleKeys, string>> = { en, de, hr };

/** Human-readable language names for prompt injection */
export const LANGUAGE_NAMES: Record<SupportedLocale, string> = {
  en: "English",
  de: "German",
  hr: "Croatian",
};

/**
 * Maps tinyld ISO-639-1 codes to our supported locales.
 * Handles related languages (e.g. Bosnian → Croatian).
 * Add new mappings here when expanding language support.
 */
const LANGUAGE_MAP: Record<string, SupportedLocale> = {
  // Germanic
  de: "de",
  nds: "de",  // Low German
  // Slavic (Croatian covers Bosnian/Serbian/Montenegrin)
  hr: "hr",
  bs: "hr",   // Bosnian
  sr: "hr",   // Serbian
  sl: "hr",   // Slovenian
  mk: "hr",   // Macedonian
  bg: "hr",   // Bulgarian
  cs: "hr",   // Czech (close enough)
  sk: "hr",   // Slovak (close enough)
  pl: "hr",   // Polish (close enough)
  // English
  en: "en",
};

// ── Language detection ─────────────────────────────────────────────────────

/**
 * Detect language from text and map to a supported locale.
 *
 * @param text - User input text
 * @returns Supported locale code (defaults to "en")
 */
export function detectLanguage(text: string): SupportedLocale {
  if (!text || text.trim().length === 0) return "en";

  try {
    const raw = detect(text);
    const iso2 = toISO2(raw);
    return LANGUAGE_MAP[iso2] ?? "en";
  } catch {
    return "en";
  }
}

/**
 * Map a raw language code (e.g. from STT adapter) to a supported locale.
 *
 * @param rawLang - ISO 639-1 or ISO 639-3 code
 * @returns Supported locale code (defaults to "en")
 */
export function mapToSupported(rawLang: string | undefined | null): SupportedLocale {
  if (!rawLang) return "en";
  const iso2 = toISO2(rawLang);
  return LANGUAGE_MAP[iso2] ?? "en";
}

// ── Translation ────────────────────────────────────────────────────────────

/**
 * Get a translated string by key and locale.
 * Supports parameter interpolation: `t("model_changed", "de", { model: "gpt-4" })`
 *
 * @param key - Translation key
 * @param locale - Target locale
 * @param params - Optional interpolation parameters
 * @returns Translated string (falls back to English if key missing)
 */
export function t<K extends LocaleKeys>(
  key: K,
  locale: SupportedLocale,
  params?: Record<string, string | number>,
): string {
  const catalog = LOCALES[locale] ?? LOCALES.en;
  let text = catalog[key] ?? en[key];

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }

  return text;
}

// ── Tool name translation ──────────────────────────────────────────────────

/** Maps tool IDs to locale-aware display names */
const TOOL_NAMES: Record<string, Record<SupportedLocale, string>> = {
  "household-execute-query": { en: "SQL query", de: "SQL-Abfrage", hr: "SQL upit" },
  "household-manage": { en: "household data", de: "Haushaltsdaten", hr: "podaci kućanstva" },
  "household-upload-receipt": { en: "receipt scanner", de: "Beleg-Scanner", hr: "skener računa" },
  "household-weather": { en: "weather lookup", de: "Wetterabfrage", hr: "prognoza vremena" },
  "household-traffic": { en: "traffic lookup", de: "Verkehrsabfrage", hr: "prometne informacije" },
  "household-tts": { en: "text-to-speech", de: "Text-zu-Sprache", hr: "tekst u govor" },
  "household-stt": { en: "speech-to-text", de: "Sprache-zu-Text", hr: "govor u tekst" },
  "webfetch": { en: "web search", de: "Websuche", hr: "web pretraga" },
  "bash": { en: "terminal", de: "Terminal", hr: "terminal" },
  "read": { en: "file reader", de: "Datei lesen", hr: "čitanje datoteke" },
  "write": { en: "file writer", de: "Datei schreiben", hr: "pisanje datoteke" },
  "edit": { en: "file editor", de: "Datei bearbeiten", hr: "uređivanje datoteke" },
  "glob": { en: "file search", de: "Dateisuche", hr: "pretraga datoteka" },
  "grep": { en: "content search", de: "Inhaltssuche", hr: "pretraga sadržaja" },
  "skill": { en: "loading skill", de: "Lade Skill", hr: "učitavanje vještine" },
};

/**
 * Get a translated display name for a tool.
 *
 * @param toolId - Tool identifier (e.g. "bash")
 * @param locale - Target locale
 * @returns Localized tool name (falls back to raw toolId)
 */
export function toolName(toolId: string, locale: SupportedLocale): string {
  return TOOL_NAMES[toolId]?.[locale] ?? TOOL_NAMES[toolId]?.en ?? toolId;
}

// ── Emotion name translation ─────────────────────────────────────────────

/** Maps SenseVoice emotion codes to locale-aware display names */
const EMOTION_NAMES: Record<string, Record<SupportedLocale, string>> = {
  "HAPPY": { en: "happy", de: "glücklich", hr: "sretan" },
  "SAD": { en: "sad", de: "traurig", hr: "tužan" },
  "ANGRY": { en: "angry", de: "wütend", hr: "ljut" },
  "NEUTRAL": { en: "neutral", de: "neutral", hr: "neutralan" },
  "FEARFUL": { en: "fearful", de: "ängstlich", hr: "uplašen" },
  "DISGUSTED": { en: "disgusted", de: "angewidert", hr: "zgađen" },
  "SURPRISED": { en: "surprised", de: "überrascht", hr: "iznenađen" },
  "EMO_UNKNOWN": { en: "unknown", de: "unbekannt", hr: "nepoznat" },
};

/**
 * Get a translated display name for an emotion code.
 *
 * @param emotionCode - SenseVoice emotion code (e.g. "HAPPY", "SAD")
 * @param locale - Target locale
 * @returns Localized emotion name (falls back to raw code)
 */
export function emotionName(emotionCode: string, locale: SupportedLocale): string {
  const normalized = emotionCode.toUpperCase();
  return EMOTION_NAMES[normalized]?.[locale] ?? EMOTION_NAMES[normalized]?.en ?? emotionCode;
}

// ── Audio event name translation ──────────────────────────────────────────

/** Maps SenseVoice audio event codes to locale-aware display names */
const AUDIO_EVENT_NAMES: Record<string, Record<SupportedLocale, string>> = {
  "BGM": { en: "background music", de: "Hintergrundmusik", hr: "pozadinska glazba" },
  "Applause": { en: "applause", de: "Applaus", hr: "pljesak" },
  "Laughter": { en: "laughter", de: "Lachen", hr: "smijeh" },
  "Crying": { en: "crying", de: "Weinen", hr: "plakanje" },
  "Coughing": { en: "coughing", de: "Husten", hr: "kašalj" },
  "Sneezing": { en: "sneezing", de: "Niesen", hr: "kihanje" },
  "Speech": { en: "speech", de: "Sprache", hr: "govor" },
};

/**
 * Get a translated display name for an audio event code.
 *
 * @param eventCode - SenseVoice audio event code (e.g. "Laughter", "Applause")
 * @param locale - Target locale
 * @returns Localized event name (falls back to raw code)
 */
export function audioEventName(eventCode: string, locale: SupportedLocale): string {
  return AUDIO_EVENT_NAMES[eventCode]?.[locale] ?? AUDIO_EVENT_NAMES[eventCode]?.en ?? eventCode;
}

// ── Exports ────────────────────────────────────────────────────────────────

export type { LocaleKeys };
