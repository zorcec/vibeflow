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
    if (!text || text.length > 10_000) {
      throw new Error("Text must be between 1 and 10,000 characters");
    }

    const language = options.language ?? "en";

    const body: Record<string, string> = { text, language };
    if (options.voice) body.voice = options.voice;
    if (options.emotion) body.emotion = options.emotion;
    if (options.rate) body.rate = options.rate;
    if (options.pitch) body.pitch = options.pitch;
    if (options.volume) body.volume = options.volume;

    const res = await fetch(`${this.url}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      // Sanitize error — don't leak internal server details
      throw new Error(`TTS synthesis failed (${res.status})`);
    }

    // Save audio to disk
    mkdirSync(this.tmpDir, { recursive: true });
    const audioBuffer = Buffer.from(await res.arrayBuffer());
    const audioPath = join(this.tmpDir, `tts-${Date.now()}.mp3`);
    writeFileSync(audioPath, audioBuffer);

    return {
      audioPath,
      language,
      voice: options.voice,
      emotion: options.emotion,
    };
  }
}
