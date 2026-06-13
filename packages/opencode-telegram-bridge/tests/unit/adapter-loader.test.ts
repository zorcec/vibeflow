import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadSTT, loadTTS, resolveAdapters } from "../../src/adapter-loader.js";
import type { STTAdapter, TTSAdapter } from "../../src/types.js";

// Mock adapters for testing
class MockSTT implements STTAdapter {
  readonly name = "mock-stt";
  async transcribe(buffer: Buffer, mimeType: string) {
    return { text: "transcribed text", language: "en" };
  }
}

class MockTTS implements TTSAdapter {
  readonly name = "mock-tts";
  async synthesize(text: string, options: any) {
    return { audioPath: "/tmp/test.mp3", language: "en" };
  }
}

describe("adapter-loader", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("loadSTT", () => {
    it("loads built-in sensevoice adapter", async () => {
      // SenseVoice requires fetch, so we mock it
      const adapter = await loadSTT("sensevoice");
      expect(adapter.name).toBe("sensevoice");
      expect(typeof adapter.transcribe).toBe("function");
    });

    it("throws for invalid built-in name", async () => {
      await expect(loadSTT("nonexistent")).rejects.toThrow("Failed to load STT adapter");
    });

    it("throws for invalid module path", async () => {
      await expect(loadSTT("/nonexistent/path/adapter.js")).rejects.toThrow("Invalid adapter source");
    });
  });

  describe("loadTTS", () => {
    it("loads built-in edge-tts adapter", async () => {
      const adapter = await loadTTS("edge-tts");
      expect(adapter.name).toBe("edge-tts");
      expect(typeof adapter.synthesize).toBe("function");
    });

    it("throws for invalid built-in name", async () => {
      await expect(loadTTS("nonexistent")).rejects.toThrow("Failed to load TTS adapter");
    });

    it("throws for invalid module path", async () => {
      await expect(loadTTS("/nonexistent/path/adapter.js")).rejects.toThrow("Invalid adapter source");
    });
  });

  describe("resolveAdapters", () => {
    it("returns override adapters when provided", async () => {
      const mockSTT = new MockSTT();
      const mockTTS = new MockTTS();
      const result = await resolveAdapters({ stt: mockSTT, tts: mockTTS });
      expect(result.stt).toBe(mockSTT);
      expect(result.tts).toBe(mockTTS);
    });

    it("returns null when no adapters configured", async () => {
      delete process.env.STT_ADAPTER;
      delete process.env.TTS_ADAPTER;
      delete process.env.SENSEVOICE_URL;
      const result = await resolveAdapters();
      expect(result.stt).toBeNull();
      expect(result.tts).toBeNull();
    });

    it("loads adapters from env vars", async () => {
      // We can't easily test dynamic import of arbitrary modules in unit tests
      // but we can test the built-in shortcuts
      process.env.SENSEVOICE_URL = "http://localhost:9001";
      const result = await resolveAdapters();
      expect(result.stt).not.toBeNull();
      expect(result.tts).not.toBeNull();
    });
  });
});
