/**
 * Adapter interfaces for STT (Speech-to-Text) and TTS (Text-to-Speech).
 *
 * Adapters are loaded dynamically at runtime via:
 *   - Environment variables: STT_ADAPTER, TTS_ADAPTER
 *   - Programmatic API: createBot({ stt: myAdapter, tts: myAdapter })
 *   - Built-in defaults: sensevoice (STT), edge-tts (TTS)
 */

// ── STT ──────────────────────────────────────────────────────────────────────

export interface STTResult {
  /** Transcribed text */
  text: string;
  /** Detected emotion (e.g. "happy", "sad", "neutral") */
  emotion?: string;
  /** Audio events detected (e.g. "music", "applause") */
  audioEvents?: string[];
  /** Detected language code (e.g. "en", "de") */
  language?: string;
}

export interface STTAdapter {
  /** Human-readable adapter name (e.g. "sensevoice", "whisper") */
  readonly name: string;
  /**
   * Transcribe an audio buffer to text.
   * @param buffer - Raw audio data
   * @param mimeType - MIME type of the audio (e.g. "audio/ogg", "audio/wav")
   * @returns Transcription result with text and optional metadata
   */
  transcribe(buffer: Buffer, mimeType: string): Promise<STTResult>;
}

// ── TTS ──────────────────────────────────────────────────────────────────────

export interface TTSOptions {
  /** Language code: en, de, hr, zh, ja */
  language?: string;
  /** Explicit voice name (e.g. "en-US-AndrewNeural", "en-US-AvaNeural") */
  voice?: string;
  /** Emotion preset: happy, sad, angry, excited, calm, neutral, playful, serious */
  emotion?: string;
  /** Speech rate adjustment (e.g. "+15%", "-20%") */
  rate?: string;
  /** Pitch adjustment (e.g. "+5Hz", "-3Hz") */
  pitch?: string;
  /** Volume adjustment (e.g. "+10%", "-10%") */
  volume?: string;
}

export interface TTSResult {
  /** Path to the generated audio file */
  audioPath: string;
  /** Language used for synthesis */
  language: string;
  /** Voice name used */
  voice?: string;
  /** Emotion applied */
  emotion?: string;
}

export interface TTSAdapter {
  /** Human-readable adapter name (e.g. "edge-tts", "openai-tts") */
  readonly name: string;
  /**
   * Convert text to speech.
   * @param text - Text to synthesize
   * @param options - Synthesis options
   * @returns Result with path to generated audio file
   */
  synthesize(text: string, options: TTSOptions): Promise<TTSResult>;
}

// ── Adapter Module (for dynamic import) ──────────────────────────────────────

/**
 * Default export shape for adapter modules loaded via dynamic import().
 *
 * An adapter module can export:
 *   - A class implementing STTAdapter or TTSAdapter
 *   - A factory function: createSTT() or createTTS()
 *   - A default object implementing the adapter interface
 */
export interface STTAdapterModule {
  default: STTAdapter | (() => STTAdapter);
  createSTT?: () => STTAdapter;
}

export interface TTSAdapterModule {
  default: TTSAdapter | (() => TTSAdapter);
  createTTS?: () => TTSAdapter;
}

// ── Bot Configuration ────────────────────────────────────────────────────────

export interface BridgeConfig {
  /** Telegram bot token (required) */
  token: string;
  /** OpenCode server URL (default: http://localhost:4096) */
  opencodeUrl?: string;
  /** Comma-separated list of allowed Telegram user IDs */
  allowedUsers?: string;
  /** Default AI model (default: opencode-go/mimo-v2.5) */
  defaultModel?: string;
  /** Health endpoint port (default: 3001) */
  port?: number;
  /** STT adapter instance (overrides STT_ADAPTER env) */
  stt?: STTAdapter;
  /** TTS adapter instance (overrides TTS_ADAPTER env) */
  tts?: TTSAdapter;
  /** Available models for /model command (default: opencode-go/* defaults) */
  availableModels?: string[];
}
