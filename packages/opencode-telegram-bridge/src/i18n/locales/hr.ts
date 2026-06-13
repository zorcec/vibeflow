/**
 * Croatian locale.
 *
 * To add a new language: copy en.ts, translate all values,
 * then register the locale in src/i18n/index.ts (SUPPORTED_LOCALES + import).
 */

import type { LocaleKeys } from "./en.js";

const hr: Record<LocaleKeys, string> = {
  // ── Rate limiting / queue ──────────────────────────────────────────────────
  "rate_limited": "Ograničenje brzine. Pokušaj ponovo za {retryAfter}s.",
  "queue_full": "⏳ Red pun. Pričekajte da se završi trenutni zahtjev.",
  "queued": "⏳ U redu čekanja ({count} čeka)...",

  // ── Status messages ────────────────────────────────────────────────────────
  "thinking": "🤔 _Razmišljam..._",
  "writing": "📝 _Pišem..._",
  "running_tool": "🔧 _Pokretanje: {tool}..._",
  "creating_session": "🔄 _Kreiranje sesije..._",
  "session_expired": "🔄 _Sesija istekla. Ponovno spajanje..._",
  "transcribing": "🎙️ _Transkribiram..._",

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  "heartbeat_still_working": "⏱️ _Još radim..._ {elapsed}",
  "heartbeat_steps": "🔧 _Koraci: {count} ({chain})_",
  "heartbeat_cost": "💰 _{cost}_",

  // ── Phase labels ───────────────────────────────────────────────────────────
  "phase_analyzing": "Analiziram",
  "phase_running_tool": "Pokrećem alat",
  "phase_generating": "Generiram odgovor",

  // ── Empty / error responses ────────────────────────────────────────────────
  "no_response": "(Nema odgovora od asistenta)",
  "voice_no_text": "Glasovna poruka nije proizvela tekst. Pokušajte ponovo ili pošaljite tekstualnu poruku.",
  "unknown_command": "Nepoznata naredba: {command}",

  // ── /start and /help ──────────────────────────────────────────────────────
  "start_help": "👋 *OpenCode Telegram Bridge*\n\nChatajte s AI asistentom putem OpenCode-a.\n\n*Naredbe:*\n/new — Započni novi razgovor\n/stop — Prekini trenutni zahtjev\n/model — Promijeni AI model\n/sessions — Prikaži sve razgovore\n/switch — Prebaci se na razgovor\n/delete — Obriši trenutni razgovor\n/history — Prikaži nedavne poruke\n/providers — Prikaži AI pružatelje\n/status — Provjeri vezu\n/help — Prikaži ovu pomoć\n\nPošaljite tekstualne ili glasovne poruke.",

  // ── /new ───────────────────────────────────────────────────────────────────
  "new_session": "✅ Nova sesija kreirana. Pošaljite poruku za početak.",

  // ── /stop ──────────────────────────────────────────────────────────────────
  "stop_cancelled": "⏹️ Zahtjev otkazan.",
  "nothing_to_cancel": "Ništa za otkazati.",

  // ── /model ─────────────────────────────────────────────────────────────────
  "model_unknown": "Nepoznat model: `{model}`\nKoristite /model za dostupne opcije.",
  "model_changed": "✅ Model promijenjen u: {model}",
  "model_select": "Odaberite model:",

  // ── /status ────────────────────────────────────────────────────────────────
  "status_connected": "✅ Povezano",
  "status_disconnected": "❌ Nije povezano",
  "status_format": "*Status:* {status}\n*Model:* {model}\n*Glas:* {voice}",
  "stt_not_configured": "STT: nije konfigurirano",

  // ── /sessions ──────────────────────────────────────────────────────────────
  "sessions_none": "Nema pronađenih razgovora. Pošaljite poruku za početak.",
  "sessions_list": "📋 *Sesije:*",
  "sessions_error": "Greška pri dohvaćanju sesija: {error}",

  // ── /switch ────────────────────────────────────────────────────────────────
  "switch_not_found": "Sesija nije pronađena. Koristite /sessions za dostupne sesije.",
  "switch_success": "✅ Prebačeno na sesiju: `{id}`",
  "switch_select": "🔄 *Odaberite sesiju za prebacivanje:*",
  "switch_error": "Greška pri provjeri sesije: {error}",
  "switch_list_error": "Greška pri dohvaćanju sesija: {error}",
  "switch_no_sessions": "Nema pronađenih razgovora.",
  "switch_callback": "Sesija prebačena",

  // ── /delete ────────────────────────────────────────────────────────────────
  "delete_none": "Nema aktivne sesije za brisanje.",
  "delete_success": "🗑️ Sesija obrisana. Svjež početak.",
  "delete_local": "🗑️ Sesija lokalno obrisana. Svjež početak.",

  // ── /history ───────────────────────────────────────────────────────────────
  "history_none_session": "Nema aktivne sesije. Pošaljite poruku za početak.",
  "history_none_messages": "Još nema poruka u ovoj sesiji.",
  "history_you": "👤 *Ti*",
  "history_assistant": "🤖 *Asistent*",
  "history_no_text": "(bez teksta)",
  "history_error": "Greška pri dohvaćanju povijesti: {error}",

  // ── /providers ─────────────────────────────────────────────────────────────
  "providers_none": "Nema pružatelja usluga.",
  "providers_no_models": "(nema modela)",
  "providers_error": "Greška pri dohvaćanju pružatelja: {error}",

  // ── Voice ──────────────────────────────────────────────────────────────────
  "voice_not_configured": "Glasovna obrada nije konfigurirana. Pošaljite tekstualnu poruku.",
  "voice_failed": "Glasovna obrada nije uspjela: {error}",
  "voice_emotion_prefix": "[Glas - korisnik zvuči {emotion}]",
  "voice_prefix": "[Glas]",

  // ── Receipt ────────────────────────────────────────────────────────────────
  "receipt_failed": "Obrada računa nije uspjela: {error}",

  // ── Auth ───────────────────────────────────────────────────────────────────
  "access_denied": "⛔ Pristup odbijen.",

  // ── General error ──────────────────────────────────────────────────────────
  "error_prefix": "❌ Greška: {message}",
};

export default hr;
