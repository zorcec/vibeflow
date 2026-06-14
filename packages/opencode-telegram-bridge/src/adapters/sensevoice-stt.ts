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
const DEBUG = process.env.DEBUG_BRIDGE === "true" || process.env.DEBUG === "true";

function logDebug(msg: string, ...args: unknown[]): void {
  if (DEBUG) console.log(`[sensevoice-stt:debug] ${msg}`, ...args);
}

function logInfo(msg: string, ...args: unknown[]): void {
  console.log(`[sensevoice-stt:info] ${msg}`, ...args);
}

function logError(msg: string, ...args: unknown[]): void {
  console.error(`[sensevoice-stt:error] ${msg}`, ...args);
}

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

  async transcribe(buffer: Buffer, mimeType: string, languageHint?: string): Promise<STTResult> {
    const startTime = Date.now();
    const ext = mimeToExt(mimeType);
    const ts = Date.now();
    const tmpIn = join(this.tmpDir, `stt-input-${ts}${ext}`);
    const tmpWav = join(this.tmpDir, `stt-output-${ts}.wav`);

    logInfo(`transcribe: start - buffer=${buffer.length} bytes, mime=${mimeType}, ext=${ext}, hint=${languageHint || 'auto'}`);

    try {
      mkdirSync(this.tmpDir, { recursive: true });
      writeFileSync(tmpIn, buffer);
      logDebug(`transcribe: saved input to ${tmpIn}`);

      // Convert to WAV if not already — use execFileSync to avoid shell injection
      if (ext !== ".wav") {
        logDebug(`transcribe: converting ${ext} to WAV via ffmpeg`);
        execFileSync("ffmpeg", ["-y", "-i", tmpIn, "-ar", "16000", "-ac", "1", tmpWav], {
          timeout: 30_000,
          stdio: "pipe",
        });
      }

      const wavBuf = ext === ".wav" ? readFileSync(tmpIn) : readFileSync(tmpWav);
      logDebug(`transcribe: WAV ready, size=${wavBuf.length} bytes`);

      const blob = new Blob([wavBuf], { type: "audio/wav" });
      const formData = new FormData();
      formData.append("audio", blob, "audio.wav");
      
      // Add language hint if provided
      if (languageHint && languageHint !== "auto") {
        formData.append("language", languageHint);
        logDebug(`transcribe: sending language hint: ${languageHint}`);
      }

      logInfo(`transcribe: sending to ${this.url}/transcribe`);
      const fetchStart = Date.now();

      const res = await fetch(`${this.url}/transcribe`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });

      const fetchElapsed = Date.now() - fetchStart;
      logDebug(`transcribe: response status=${res.status}, elapsed=${fetchElapsed}ms`);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        logError(`transcribe: failed with status ${res.status}: ${errText}`);
        throw new Error(`SenseVoice transcription failed (${res.status})`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      const elapsed = Date.now() - startTime;
      
      logInfo(`transcribe: success - engine=${data.engine || 'sensevoice'}, lang=${data.language}, ` +
              `emotion=${data.emotion}, text_length=${(data.text as string)?.length || 0}, ` +
              `elapsed=${elapsed}ms`);

      return {
        text: (data.text as string) || "",
        emotion: (data.emotion as string) || undefined,
        audioEvents: (data.audio_events as string[]) || undefined,
        language: (data.language as string) || undefined,
        rawLanguage: (data.raw_language as string) || undefined,
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      logError(`transcribe: failed after ${elapsed}ms - ${(err as Error).message}`);
      throw err;
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
