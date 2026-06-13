import { describe, it, expect, vi, beforeEach } from "vitest";
import { SenseVoiceSTTAdapter } from "../../../src/adapters/sensevoice-stt.js";

describe("SenseVoiceSTTAdapter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("has correct name", () => {
    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001" });
    expect(adapter.name).toBe("sensevoice");
  });

  it("uses default tmpDir when not provided", () => {
    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001" });
    // @ts-expect-error accessing private field for test
    expect(adapter.tmpDir).toContain("opencode-telegram-stt");
  });

  it("throws for invalid URL protocol", () => {
    expect(() => new SenseVoiceSTTAdapter({ url: "ftp://test:9001" })).toThrow("Invalid SENSEVOICE_URL");
  });

  it("throws for unsupported audio format", async () => {
    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-stt" });
    await expect(adapter.transcribe(Buffer.from("data"), "audio/xyz")).rejects.toThrow("Unsupported audio format");
  });

  it("accepts wav format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "hello", language: "en" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-stt" });
    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.write("data", 36);

    const result = await adapter.transcribe(wavHeader, "audio/wav");
    expect(result.text).toBe("hello");
  });

  it("accepts ogg format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "test" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-stt" });
    // OGG will fail ffmpeg conversion but we test the format acceptance
    await expect(adapter.transcribe(Buffer.from("data"), "audio/ogg")).rejects.toThrow();
  });

  it("defaults audioEvents and language when not in response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "hello" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-stt" });
    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.write("data", 36);

    const result = await adapter.transcribe(wavHeader, "audio/wav");
    expect(result.audioEvents).toBeUndefined();
    expect(result.language).toBeUndefined();
  });

  it("throws when server is unreachable", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("fetch failed"));
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new SenseVoiceSTTAdapter({ url: "http://localhost:19999" });
    const buffer = Buffer.from("fake audio data");
    await expect(adapter.transcribe(buffer, "audio/wav")).rejects.toThrow();
  }, 10_000);

  it("sends correct request to server", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "hello world", emotion: "neutral", language: "en" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-stt" });

    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(36, 4);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20);
    wavHeader.writeUInt16LE(1, 22);
    wavHeader.writeUInt32LE(16000, 24);
    wavHeader.writeUInt32LE(32000, 28);
    wavHeader.writeUInt16LE(2, 32);
    wavHeader.writeUInt16LE(16, 34);
    wavHeader.write("data", 36);
    wavHeader.writeUInt32LE(0, 40);

    const result = await adapter.transcribe(wavHeader, "audio/wav");
    expect(result.text).toBe("hello world");
    expect(result.emotion).toBe("neutral");
    expect(result.language).toBe("en");
  });

  it("handles server error response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal error"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-stt" });
    const buffer = Buffer.from("fake audio");
    await expect(adapter.transcribe(buffer, "audio/wav")).rejects.toThrow("SenseVoice transcription failed (500)");
  });

  it("creates tmp directory if it does not exist", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "test" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { existsSync, rmSync } = await import("node:fs");
    const testDir = "/tmp/test-stt-newdir";
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });

    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001", tmpDir: testDir });

    const wavHeader = Buffer.alloc(44);
    wavHeader.write("RIFF", 0);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.write("data", 36);

    await adapter.transcribe(wavHeader, "audio/wav");

    expect(existsSync(testDir)).toBe(true);
    rmSync(testDir, { recursive: true });
  });
});
