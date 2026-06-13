/**
 * OpenCode Telegram Bridge — CLI entry point.
 *
 * Usage:
 *   opencode-telegram --token YOUR_BOT_TOKEN
 *   opencode-telegram --token YOUR_BOT_TOKEN --opencode-url http://localhost:4096
 *   opencode-telegram --help
 */

import { createBot } from "./bot.js";

function printHelp(): void {
  console.log(`
OpenCode Telegram Bridge

Standalone Telegram bot that bridges to OpenCode for AI-powered conversations.

Usage:
  opencode-telegram [options]

Options:
  --token <token>          Telegram bot token (or set TELEGRAM_BOT_TOKEN env)
  --opencode-url <url>     OpenCode server URL (default: http://localhost:4096)
  --allowed-users <ids>    Comma-separated allowed Telegram user IDs
  --model <model>          Default AI model (default: opencode-go/mimo-v2.5)
  --port <port>            Health endpoint port (default: 3001)
  --stt-adapter <source>   STT adapter module path or "sensevoice"
  --tts-adapter <source>   TTS adapter module path or "edge-tts"
  --help                   Show this help message

Environment Variables:
  TELEGRAM_BOT_TOKEN       Telegram bot token (required if --token not provided)
  OPENCODE_URL             OpenCode server URL
  TELEGRAM_ALLOWED_USERS   Comma-separated allowed user IDs
  TELEGRAM_DEFAULT_MODEL   Default AI model
  PORT                     Health endpoint port
  SESSIONS_DIR             Session storage directory
  STT_ADAPTER              STT adapter module or shorthand
  TTS_ADAPTER              TTS adapter module or shorthand
  SENSEVOICE_URL           SenseVoice server URL (auto-loads adapters)
  RATE_LIMIT_MAX           Max requests per window (default: 10)
  RATE_LIMIT_WINDOW_MS     Rate limit window in ms (default: 60000)

Adapter Loading:
  Adapters are loaded dynamically at runtime. You can:
    1. Pass --stt-adapter /path/to/adapter.ts
    2. Set STT_ADAPTER=whisper (npm package)
    3. Use built-in: sensevoice, edge-tts
    4. No adapter = voice features disabled

Examples:
  # Basic usage with SenseVoice server
  TELEGRAM_BOT_TOKEN=xxx SENSEVOICE_URL=http://localhost:9001 opencode-telegram

  # With custom adapter
  TELEGRAM_BOT_TOKEN=xxx STT_ADAPTER=./my-whisper-adapter.ts opencode-telegram

  # Text-only (no voice)
  TELEGRAM_BOT_TOKEN=xxx opencode-telegram
`);
}

// Parse CLI args
function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = "true";
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = "true";
      }
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const token = args.token || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("[bridge] Error: Telegram bot token is required.");
    console.error("[bridge] Use --token YOUR_TOKEN or set TELEGRAM_BOT_TOKEN env.");
    process.exit(1);
  }

  // Resolve STT/TTS adapter from CLI args
  if (args["stt-adapter"]) {
    process.env.STT_ADAPTER = args["stt-adapter"];
  }
  if (args["tts-adapter"]) {
    process.env.TTS_ADAPTER = args["tts-adapter"];
  }

  try {
    await createBot({
      token,
      opencodeUrl: args["opencode-url"],
      allowedUsers: args["allowed-users"],
      defaultModel: args.model,
      port: args.port ? parseInt(args.port, 10) : undefined,
    });
  } catch (err) {
    console.error("[bridge] Fatal error:", (err as Error).message);
    process.exit(1);
  }
}

main();
