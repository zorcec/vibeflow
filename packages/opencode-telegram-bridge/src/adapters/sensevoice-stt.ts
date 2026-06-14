/**
 * Built-in SenseVoice STT adapter.
 *
 * Transcribes audio via a self-hosted SenseVoice server.
 * Converts non-WAV audio to WAV via ffmpeg before sending.
 *
 * Environment variables:
 *   SENSEVOICE_URL — SenseVoice server URL (default: http://localhost:9001)
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { STTAdapter, STTResult } from "../types.js";
import { validateUrl } from "../validate-url.js";

const DEFAULT_SENSEVOICE_URL = "http://localhost:9001";
const SAFE_EXTENSIONS = new Set([".wav", ".ogg", ".mp3", ".webm", ".opus"]);

/** Map MIME type to file extension */
function mimeToExt(mimeType: string): string {
  if (mimeType.includes("wav")) return ".wav";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("mp3")) return ".mp3";
  if (mimeType.includes("webm")) return ".webm";
  if (mimeType.includes("opus")) return ".opus";
  throw new Error(`Unsupported audio format: ${mimeType}`);
}

export class SenseVoiceSTTAdapter implements STTAdapter {
  readonly name = "sensevoice";
  private url: string;
  private tmpDir: string;

  constructor(options?: { url?: string; tmpDir?: string }) {
    this.url = options?.url || process.env.SENSEVOICE_URL || DEFAULT_SENSEVOICE_URL;
    this.tmpDir = options?.tmpDir || join(tmpdir(), "opencode-telegram-stt");
    validateUrl(this.url, "SENSEVOICE_URL");
  }

  async transcribe(buffer: Buffer, mimeType: string): Promise<STTResult> {
    const ext = mimeToExt(mimeType);
    const ts = Date.now();
    const tmpIn = join(this.tmpDir, `stt-input-${ts}${ext}`);
    const tmpWav = join(this.tmpDir, `stt-output-${ts}.wav`);

    try {
      mkdirSync(this.tmpDir, { recursive: true });
      writeFileSync(tmpIn, buffer);

      // Convert to WAV if not already — use execFileSync to avoid shell injection
      if (ext !== ".wav") {
        execFileSync("ffmpeg", ["-y", "-i", tmpIn, "-ar", "16000", "-ac", "1", tmpWav], {
          timeout: 30_000,
          stdio: "pipe",
        });
      }

      const wavBuf = ext === ".wav" ? readFileSync(tmpIn) : readFileSync(tmpWav);
      const blob = new Blob([wavBuf], { type: "audio/wav" });
      const formData = new FormData();
      formData.append("audio", blob, "audio.wav");

      const res = await fetch(`${this.url}/transcribe`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        // Sanitize error — don't leak internal server details
        throw new Error(`SenseVoice transcription failed (${res.status})`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      return {
        text: (data.text as string) || "",
        emotion: (data.emotion as string) || undefined,
        audioEvents: (data.audio_events as string[]) || undefined,
        language: (data.language as string) || undefined,
      };
    } finally {
      try {
        unlinkSync(tmpIn);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(tmpWav);
      } catch {
        /* ignore */
      }
    }
  }
}
