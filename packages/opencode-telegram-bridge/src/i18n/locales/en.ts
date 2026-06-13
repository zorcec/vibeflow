/**
 * English locale — default fallback.
 *
 * To add a new language: copy this file, translate all values,
 * then register the locale in src/i18n/index.ts (SUPPORTED_LOCALES + import).
 */

const en = {
  // ── Rate limiting / queue ──────────────────────────────────────────────────
  "rate_limited": "Rate limited. Try again in {retryAfter}s.",
  "queue_full": "⏳ Queue full. Please wait for the current request to finish.",
  "queued": "⏳ Queued ({count} waiting)...",

  // ── Status messages ────────────────────────────────────────────────────────
  "thinking": "🤔 _Thinking..._",
  "writing": "📝 _Writing..._",
  "running_tool": "🔧 _Running {tool}..._",
  "creating_session": "🔄 _Creating session..._",
  "session_expired": "🔄 _Session expired. Reconnecting..._",
  "transcribing": "🎙️ _Transcribing..._",

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  "heartbeat_still_working": "⏱️ _Still working..._ {elapsed}",
  "heartbeat_steps": "🔧 _Steps: {count} ({chain})_",
  "heartbeat_cost": "💰 _{cost}_",

  // ── Phase labels ───────────────────────────────────────────────────────────
  "phase_analyzing": "Analyzing",
  "phase_running_tool": "Running tool",
  "phase_generating": "Generating response",

  // ── Empty / error responses ────────────────────────────────────────────────
  "no_response": "(No response from assistant)",
  "voice_no_text": "Voice message produced no text. Please try again or send a text message.",
  "unknown_command": "Unknown command: {command}",

  // ── /start and /help ──────────────────────────────────────────────────────
  "start_help": "👋 *OpenCode Telegram Bridge*\n\nChat with the AI assistant via OpenCode.\n\n*Commands:*\n/new — Start fresh conversation\n/stop — Cancel running request\n/model — Switch AI model\n/sessions — List all conversations\n/switch — Switch to a conversation\n/delete — Delete current conversation\n/history — Show recent messages\n/providers — List AI providers\n/status — Check connection\n/help — Show this help\n\nSend text or voice messages to chat.",

  // ── /new ───────────────────────────────────────────────────────────────────
  "new_session": "✅ New session created. Send a message to start.",

  // ── /stop ──────────────────────────────────────────────────────────────────
  "stop_cancelled": "⏹️ Request cancelled.",
  "nothing_to_cancel": "Nothing to cancel.",

  // ── /model ─────────────────────────────────────────────────────────────────
  "model_unknown": "Unknown model: `{model}`\nUse /model to see available options.",
  "model_changed": "✅ Model changed to: {model}",
  "model_select": "Select a model:",

  // ── /status ────────────────────────────────────────────────────────────────
  "status_connected": "✅ Connected",
  "status_disconnected": "❌ Not connected",
  "status_format": "*Status:* {status}\n*Model:* {model}\n*Voice:* {voice}",
  "stt_not_configured": "STT: not configured",

  // ── /sessions ──────────────────────────────────────────────────────────────
  "sessions_none": "No conversations found. Send a message to start one.",
  "sessions_list": "📋 *Sessions:*",
  "sessions_error": "Failed to list sessions: {error}",

  // ── /switch ────────────────────────────────────────────────────────────────
  "switch_not_found": "Session not found. Use /sessions to see available sessions.",
  "switch_success": "✅ Switched to session: `{id}`",
  "switch_select": "🔄 *Select a session to switch to:*",
  "switch_error": "Failed to verify session: {error}",
  "switch_list_error": "Failed to list sessions: {error}",
  "switch_no_sessions": "No conversations found.",
  "switch_callback": "Session switched",

  // ── /delete ────────────────────────────────────────────────────────────────
  "delete_none": "No active session to delete.",
  "delete_success": "🗑️ Session deleted. Started fresh.",
  "delete_local": "🗑️ Session cleared locally. Started fresh.",

  // ── /history ───────────────────────────────────────────────────────────────
  "history_none_session": "No active session. Send a message to start one.",
  "history_none_messages": "No messages in this session yet.",
  "history_you": "👤 *You*",
  "history_assistant": "🤖 *Assistant*",
  "history_no_text": "(no text)",
  "history_error": "Failed to load history: {error}",

  // ── /providers ─────────────────────────────────────────────────────────────
  "providers_none": "No providers found.",
  "providers_no_models": "(no models)",
  "providers_error": "Failed to list providers: {error}",

  // ── Voice ──────────────────────────────────────────────────────────────────
  "voice_not_configured": "Voice processing not configured. Please send a text message.",
  "voice_failed": "Voice processing failed: {error}",
  "voice_emotion_prefix": "[Voice - user sounds {emotion}]",
  "voice_prefix": "[Voice]",

  // ── Receipt ────────────────────────────────────────────────────────────────
  "receipt_failed": "Receipt processing failed: {error}",

  // ── Auth ───────────────────────────────────────────────────────────────────
  "access_denied": "⛔ Access denied.",

  // ── General error ──────────────────────────────────────────────────────────
  "error_prefix": "❌ Error: {message}",
} as const;

export default en;
export type LocaleKeys = keyof typeof en;
