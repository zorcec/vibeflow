/**
 * Built-in Edge TTS adapter.
 *
 * Converts text to speech via a self-hosted SenseVoice server
 * that wraps Microsoft Edge TTS (free, natural voices).
 *
 * Supports voice selection, emotion presets, and prosody controls.
 *
 * Environment variables:
 *   SENSEVOICE_URL — SenseVoice server URL (default: http://localhost:9001)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TTSAdapter, TTSOptions, TTSResult } from "../types.js";
import { validateUrl } from "../validate-url.js";

const DEFAULT_SENSEVOICE_URL = "http://localhost:9001";
const DEBUG = process.env.DEBUG_BRIDGE === "true" || process.env.DEBUG === "true";

function logDebug(msg: string, ...args: unknown[]): void {
  if (DEBUG) console.log(`[edge-tts:debug] ${msg}`, ...args);
}

function logInfo(msg: string, ...args: unknown[]): void {
  console.log(`[edge-tts:info] ${msg}`, ...args);
}

function logError(msg: string, ...args: unknown[]): void {
  console.error(`[edge-tts:error] ${msg}`, ...args);
}

export class EdgeTTSAdapter implements TTSAdapter {
  readonly name = "edge-tts";
  private url: string;
  private tmpDir: string;

  constructor(options?: { url?: string; tmpDir?: string }) {
    this.url = options?.url || process.env.SENSEVOICE_URL || DEFAULT_SENSEVOICE_URL;
    this.tmpDir = options?.tmpDir || join(tmpdir(), "opencode-telegram-tts");
    validateUrl(this.url, "SENSEVOICE_URL");
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    const startTime = Date.now();
    
    if (!text || text.length > 10_000) {
      logError(`synthesize: invalid text length=${text?.length || 0}`);
      throw new Error("Text must be between 1 and 10,000 characters");
    }

    const language = options.language ?? "en";
    logInfo(`synthesize: start - text_length=${text.length}, lang=${language}, ` +
            `voice=${options.voice}, emotion=${options.emotion}`);

    const body: Record<string, string> = { text, language };
    if (options.voice) body.voice = options.voice;
    if (options.emotion) body.emotion = options.emotion;
    if (options.rate) body.rate = options.rate;
    if (options.pitch) body.pitch = options.pitch;
    if (options.volume) body.volume = options.volume;

    logDebug(`synthesize: sending to ${this.url}/tts`);
    const fetchStart = Date.now();

    const res = await fetch(`${this.url}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    const fetchElapsed = Date.now() - fetchStart;
    logDebug(`synthesize: response status=${res.status}, elapsed=${fetchElapsed}ms`);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      logError(`synthesize: failed with status ${res.status}: ${errText}`);
      throw new Error(`TTS synthesis failed (${res.status})`);
    }

    // Save audio to disk
    mkdirSync(this.tmpDir, { recursive: true });
    const audioBuffer = Buffer.from(await res.arrayBuffer());
    const audioPath = join(this.tmpDir, `tts-${Date.now()}.mp3`);
    writeFileSync(audioPath, audioBuffer);

    const elapsed = Date.now() - startTime;
    logInfo(`synthesize: success - output=${audioPath}, size=${audioBuffer.length} bytes, ` +
            `elapsed=${elapsed}ms`);

    return {
      audioPath,
      language,
      voice: options.voice,
      emotion: options.emotion,
    };
  }
}
