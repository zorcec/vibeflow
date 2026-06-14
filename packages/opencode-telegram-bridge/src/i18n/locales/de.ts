/**
 * German locale.
 *
 * To add a new language: copy en.ts, translate all values,
 * then register the locale in src/i18n/index.ts (SUPPORTED_LOCALES + import).
 */

import type { LocaleKeys } from "./en.js";

const de: Record<LocaleKeys, string> = {
  // ── Rate limiting / queue ──────────────────────────────────────────────────
  "rate_limited": "Ratenlimit erreicht. Versuche es in {retryAfter}s erneut.",
  "queue_full": "⏳ Warteschlange voll. Bitte warten.",
  "queued": "⏳ In Warteschlange ({count} warten)...",

  // ── Status messages ────────────────────────────────────────────────────────
  "thinking": "🤔 _Nachdenken..._",
  "writing": "📝 _Schreibe..._",
  "responding": "💬 _Antworte..._",
  "running_tool": "🔧 _Ausführen: {tool}..._",
  "creating_session": "🔄 _Sitzung wird erstellt..._",
  "session_expired": "🔄 _Sitzung abgelaufen. Verbinde neu..._",
  "transcribing": "🎙️ _Transkribiere..._",
  "transcribed": "🎙️ _Transkribiert:_ {text}",

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  "heartbeat_still_working": "⏱️ _Arbeite noch..._ {elapsed}",
  "heartbeat_steps": "🔧 _Schritte: {count} ({chain})_",
  "heartbeat_cost": "💰 _{cost}_",

  // ── Phase labels ───────────────────────────────────────────────────────────
  "phase_analyzing": "Analysiere",
  "phase_running_tool": "Führe Werkzeug aus",
  "phase_generating": "Generiere Antwort",
  "phase_responding": "Antworte",
  "phase_coding": "Code",
  "phase_searching": "Suche",

  // ── Empty / error responses ────────────────────────────────────────────────
  "no_response": "(Keine Antwort vom Assistenten)",
  "voice_no_text": "Sprachnachricht ergab keinen Text. Bitte erneut versuchen oder eine Textnachricht senden.",
  "unknown_command": "Unbekannter Befehl: {command}",

  // ── /start and /help ──────────────────────────────────────────────────────
  "start_help": "👋 *OpenCode Telegram Bridge*\n\nChatte mit dem KI-Assistenten via OpenCode.\n\n*Befehle:*\n/new — Neues Gespräch starten\n/stop — Laufende Anfrage abbrechen\n/model — KI-Modell wechseln\n/lang — Sprache einstellen\n/sessions — Alle Gespräche anzeigen\n/switch — Zu einem Gespräch wechseln\n/delete — Aktuelles Gespräch löschen\n/history — Letzte Nachrichten anzeigen\n/providers — KI-Anbieter anzeigen\n/status — Verbindung prüfen\n/help — Diese Hilfe anzeigen\n\nSende Text- oder Sprachnachrichten.",
  "bot_startup": "🚀 *Bot gestartet*\n\nIch bin wieder online und bereit zum Chatten\\!\n\nSende /help um verfügbare Befehle zu sehen\\.",

  // ── /lang ─────────────────────────────────────────────────────────────────
  "lang_select": "Sprache für Sprachnachrichten auswählen:",
  "lang_changed": "✅ Sprache geändert zu: {lang}",
  "lang_current": "Aktuelle Sprache: {lang}",

  // ── /new ───────────────────────────────────────────────────────────────────
  "new_session": "✅ Neue Sitzung erstellt. Sende eine Nachricht um zu starten.",
  "new_session_created": "✅ Neue OpenCode-Sitzung erstellt. Sende eine Nachricht um zu chatten.",

  // ── /stop ──────────────────────────────────────────────────────────────────
  "stop_cancelled": "⏹️ Anfrage abgebrochen.",
  "nothing_to_cancel": "Nichts zum Abbrechen.",

  // ── /model ─────────────────────────────────────────────────────────────────
  "model_unknown": "Unbekanntes Modell: `{model}`\nNutze /model für verfügbare Optionen.",
  "model_changed": "✅ Modell geändert zu: {model}",
  "model_select": "Modell auswählen:",

  // ── /status ────────────────────────────────────────────────────────────────
  "status_connected": "✅ Verbunden",
  "status_disconnected": "❌ Nicht verbunden",
  "status_format": "*Status:* {status}\n*Modell:* {model}\n*Stimme:* {voice}",
  "stt_not_configured": "STT: nicht konfiguriert",

  // ── /sessions ──────────────────────────────────────────────────────────────
  "sessions_none": "Keine Gespräche gefunden. Sende eine Nachricht um eines zu starten.",
  "sessions_list": "📋 *Sitzungen:*",
  "sessions_error": "Sitzungen konnten nicht geladen werden: {error}",

  // ── /switch ────────────────────────────────────────────────────────────────
  "switch_not_found": "Sitzung nicht gefunden. Nutze /sessions für verfügbare Sitzungen.",
  "switch_success": "✅ Gewechselt zu Sitzung: `{id}`",
  "switch_select": "🔄 *Sitzung zum Wechseln auswählen:*",
  "switch_error": "Sitzung konnte nicht verifiziert werden: {error}",
  "switch_list_error": "Sitzungen konnten nicht geladen werden: {error}",
  "switch_no_sessions": "Keine Gespräche gefunden.",
  "switch_callback": "Sitzung gewechselt",

  // ── /delete ────────────────────────────────────────────────────────────────
  "delete_none": "Keine aktive Sitzung zum Löschen.",
  "delete_success": "🗑️ Sitzung gelöscht. Neu gestartet.",
  "delete_local": "🗑️ Sitzung lokal gelöscht. Neu gestartet.",

  // ── /history ───────────────────────────────────────────────────────────────
  "history_none_session": "Keine aktive Sitzung. Sende eine Nachricht um eine zu starten.",
  "history_none_messages": "Noch keine Nachrichten in dieser Sitzung.",
  "history_you": "👤 *Du*",
  "history_assistant": "🤖 *Assistent*",
  "history_no_text": "(kein Text)",
  "history_error": "Verlauf konnte nicht geladen werden: {error}",

  // ── /providers ─────────────────────────────────────────────────────────────
  "providers_none": "Keine Anbieter gefunden.",
  "providers_no_models": "(keine Modelle)",
  "providers_error": "Anbieter konnten nicht geladen werden: {error}",

  // ── Voice ──────────────────────────────────────────────────────────────────
  "voice_not_configured": "Sprachverarbeitung nicht konfiguriert. Bitte sende eine Textnachricht.",
  "voice_failed": "Sprachverarbeitung fehlgeschlagen: {error}",
  "voice_emotion_prefix": "[Stimme - Benutzer klingt {emotion}]",
  "voice_prefix": "[Stimme]",

  // ── Receipt ────────────────────────────────────────────────────────────────
  "receipt_failed": "Belegverarbeitung fehlgeschlagen: {error}",

  // ── Auth ───────────────────────────────────────────────────────────────────
  "access_denied": "⛔ Zugriff verweigert.",

  // ── General error ──────────────────────────────────────────────────────────
  "error_prefix": "❌ Fehler: {message}",
};

export default de;
