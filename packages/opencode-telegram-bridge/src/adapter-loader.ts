/**
 * Dynamic adapter loader.
 *
 * Loads STT/TTS adapters at runtime from:
 *   1. Programmatic config (createBot({ stt, tts }))
 *   2. Environment variables (STT_ADAPTER, TTS_ADAPTER)
 *   3. Built-in defaults (sensevoice if SENSEVOICE_URL is set)
 *   4. null (no adapter — voice features disabled)
 *
 * Adapter resolution:
 *   - "sensevoice" → built-in SenseVoice STT adapter
 *   - "edge-tts"   → built-in Edge TTS adapter
 *   - Any other string → dynamic import() (npm package or file path)
 */

import type { STTAdapter, TTSAdapter } from "./types.js";

// ── Security: validate adapter source strings ────────────────────────────────

const BUILTIN_NAMES = new Set(["sensevoice", "edge-tts"]);

/**
 * Validate an adapter source string to prevent arbitrary code execution.
 * Only allows:
 *   - Known built-in names ("sensevoice", "edge-tts")
 *   - npm package names (alphanumeric, hyphens, scoped with @)
 * Rejects:
 *   - Absolute paths (/usr/..., C:\...)
 *   - Relative paths (./foo, ../foo)
 *   - URLs (http://..., file://...)
 */
function validateAdapterSource(source: string): void {
  if (BUILTIN_NAMES.has(source)) return;

  // Allow npm package names: @scope/name, name, name@version
  if (/^@[\w.-]+\/[\w.-]+(@[\w.-]+)?$/.test(source)) return;
  if (/^[\w.-]+(@[\w.-]+)?$/.test(source)) return;

  throw new Error(
    `Invalid adapter source "${source}". ` +
    `Only built-in names (${[...BUILTIN_NAMES].join(", ")}) or npm package names are allowed. ` +
    `Absolute paths, relative paths, and URLs are blocked for security.`,
  );
}

// ── Built-in adapter map ─────────────────────────────────────────────────────

const BUILTIN_STT = new Map<string, () => Promise<STTAdapter>>([
  [
    "sensevoice",
    async () => {
      const { SenseVoiceSTTAdapter } = await import("./adapters/sensevoice-stt.js");
      return new SenseVoiceSTTAdapter();
    },
  ],
]);

const BUILTIN_TTS = new Map<string, () => Promise<TTSAdapter>>([
  [
    "edge-tts",
    async () => {
      const { EdgeTTSAdapter } = await import("./adapters/edge-tts.js");
      return new EdgeTTSAdapter();
    },
  ],
]);

// ── STT Loader ───────────────────────────────────────────────────────────────

/**
 * Load an STT adapter from the given source string.
 *
 * @param source - Adapter identifier:
 *   - "sensevoice" → built-in adapter
 *   - "/path/to/file.ts" or "npm-package" → dynamic import()
 * @returns STTAdapter instance
 * @throws If the module doesn't export a valid adapter
 */
export async function loadSTT(source: string): Promise<STTAdapter> {
  validateAdapterSource(source);

  // Check built-in adapters first
  const builtin = BUILTIN_STT.get(source);
  if (builtin) {
    return builtin();
  }

  // Dynamic import — could be npm package or file path
  try {
    const mod = await import(source);
    return resolveSTTModule(mod);
  } catch (err) {
    throw new Error(
      `Failed to load STT adapter "${source}": ${(err as Error).message}\n` +
        `Install the package or check the file path.`,
    );
  }
}

/**
 * Resolve an STTAdapter from a dynamically imported module.
 */
function resolveSTTModule(mod: unknown): STTAdapter {
  const m = mod as Record<string, unknown>;

  // Default export is a class or instance
  if (m.default) {
    if (typeof m.default === "function") {
      // Class — instantiate it
      const instance = new (m.default as new () => STTAdapter)();
      if (typeof instance.transcribe === "function") return instance;
    }
    if (typeof m.default === "object" && m.default !== null) {
      const obj = m.default as Record<string, unknown>;
      if (typeof obj.transcribe === "function") return obj as unknown as STTAdapter;
    }
  }

  // Named export: createSTT()
  if (typeof m.createSTT === "function") {
    return (m.createSTT as () => STTAdapter)();
  }

  // Named export: stt (object with transcribe)
  if (typeof m.stt === "object" && m.stt !== null) {
    const obj = m.stt as Record<string, unknown>;
    if (typeof obj.transcribe === "function") return obj as unknown as STTAdapter;
  }

  throw new Error(
    "Module does not export a valid STTAdapter.\n" +
      "Expected: default (class/instance with transcribe()), createSTT(), or named 'stt' export.",
  );
}

// ── TTS Loader ───────────────────────────────────────────────────────────────

/**
 * Load a TTS adapter from the given source string.
 *
 * @param source - Adapter identifier:
 *   - "edge-tts" → built-in adapter
 *   - "/path/to/file.ts" or "npm-package" → dynamic import()
 * @returns TTSAdapter instance
 * @throws If the module doesn't export a valid adapter
 */
export async function loadTTS(source: string): Promise<TTSAdapter> {
  validateAdapterSource(source);

  // Check built-in adapters first
  const builtin = BUILTIN_TTS.get(source);
  if (builtin) {
    return builtin();
  }

  // Dynamic import — could be npm package or file path
  try {
    const mod = await import(source);
    return resolveTTSModule(mod);
  } catch (err) {
    throw new Error(
      `Failed to load TTS adapter "${source}": ${(err as Error).message}\n` +
        `Install the package or check the file path.`,
    );
  }
}

/**
 * Resolve a TTSAdapter from a dynamically imported module.
 */
function resolveTTSModule(mod: unknown): TTSAdapter {
  const m = mod as Record<string, unknown>;

  // Default export is a class or instance
  if (m.default) {
    if (typeof m.default === "function") {
      const instance = new (m.default as new () => TTSAdapter)();
      if (typeof instance.synthesize === "function") return instance;
    }
    if (typeof m.default === "object" && m.default !== null) {
      const obj = m.default as Record<string, unknown>;
      if (typeof obj.synthesize === "function") return obj as unknown as TTSAdapter;
    }
  }

  // Named export: createTTS()
  if (typeof m.createTTS === "function") {
    return (m.createTTS as () => TTSAdapter)();
  }

  // Named export: tts (object with synthesize)
  if (typeof m.tts === "object" && m.tts !== null) {
    const obj = m.tts as Record<string, unknown>;
    if (typeof obj.synthesize === "function") return obj as unknown as TTSAdapter;
  }

  throw new Error(
    "Module does not export a valid TTSAdapter.\n" +
      "Expected: default (class/instance with synthesize()), createTTS(), or named 'tts' export.",
  );
}

// ── Convenience: resolve all adapters from env ───────────────────────────────

export interface ResolvedAdapters {
  stt: STTAdapter | null;
  tts: TTSAdapter | null;
}

/**
 * Resolve adapters from environment variables and optional overrides.
 * Programmatic adapters take precedence over env vars.
 */
export async function resolveAdapters(overrides?: {
  stt?: STTAdapter;
  tts?: TTSAdapter;
}): Promise<ResolvedAdapters> {
  const stt = await resolveSTTAdapter(overrides?.stt);
  const tts = await resolveTTSAdapter(overrides?.tts);
  return { stt, tts };
}

async function resolveSTTAdapter(override?: STTAdapter): Promise<STTAdapter | null> {
  if (override) return override;

  const envSource = process.env.STT_ADAPTER;
  if (envSource) {
    try {
      return await loadSTT(envSource);
    } catch (err) {
      console.error(`[adapter] Failed to load STT adapter "${envSource}": ${(err as Error).message}`);
      return null;
    }
  }

  // Default: SenseVoice if URL is configured
  if (process.env.SENSEVOICE_URL) {
    try {
      return await loadSTT("sensevoice");
    } catch {
      // Fall through
    }
  }

  return null;
}

async function resolveTTSAdapter(override?: TTSAdapter): Promise<TTSAdapter | null> {
  if (override) return override;

  const envSource = process.env.TTS_ADAPTER;
  if (envSource) {
    try {
      return await loadTTS(envSource);
    } catch (err) {
      console.error(`[adapter] Failed to load TTS adapter "${envSource}": ${(err as Error).message}`);
      return null;
    }
  }

  // Default: Edge TTS if SenseVoice URL is configured (they share the server)
  if (process.env.SENSEVOICE_URL) {
    try {
      return await loadTTS("edge-tts");
    } catch {
      // Fall through
    }
  }

  return null;
}
