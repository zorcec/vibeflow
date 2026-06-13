import { describe, it, expect, vi, beforeEach } from "vitest";
import { EdgeTTSAdapter } from "../../../src/adapters/edge-tts.js";

describe("EdgeTTSAdapter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("has correct name", () => {
    const adapter = new EdgeTTSAdapter({ url: "http://test:9001" });
    expect(adapter.name).toBe("edge-tts");
  });

  it("uses default tmpDir when not provided", () => {
    const adapter = new EdgeTTSAdapter({ url: "http://test:9001" });
    // @ts-expect-error accessing private field for test
    expect(adapter.tmpDir).toContain("opencode-telegram-tts");
  });

  it("throws for invalid URL protocol", () => {
    expect(() => new EdgeTTSAdapter({ url: "ftp://test:9001" })).toThrow("Invalid SENSEVOICE_URL");
  });

  it("throws for empty text", async () => {
    const adapter = new EdgeTTSAdapter({ url: "http://test:9001" });
    await expect(adapter.synthesize("")).rejects.toThrow("Text must be between 1 and 10,000 characters");
  });

  it("throws for text exceeding 10k chars", async () => {
    const adapter = new EdgeTTSAdapter({ url: "http://test:9001" });
    const longText = "a".repeat(10_001);
    await expect(adapter.synthesize(longText)).rejects.toThrow("Text must be between 1 and 10,000 characters");
  });

  it("accepts text at exactly 10k chars", async () => {
    const audioBuffer = Buffer.from("fake mp3 data");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioBuffer.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new EdgeTTSAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-tts" });
    const text = "a".repeat(10_000);
    const result = await adapter.synthesize(text);
    expect(result.audioPath).toBeDefined();
  });

  it("defaults language to en when not provided", async () => {
    const audioBuffer = Buffer.from("fake mp3 data");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioBuffer.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new EdgeTTSAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-tts" });
    await adapter.synthesize("hello");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.language).toBe("en");
  });

  it("does not set optional fields when not provided", async () => {
    const audioBuffer = Buffer.from("fake mp3 data");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioBuffer.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new EdgeTTSAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-tts" });
    await adapter.synthesize("hello", { language: "de" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("voice");
    expect(body).not.toHaveProperty("emotion");
    expect(body).not.toHaveProperty("rate");
    expect(body).not.toHaveProperty("pitch");
    expect(body).not.toHaveProperty("volume");
  });

  it("throws when server is unreachable", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("fetch failed"));
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new EdgeTTSAdapter({ url: "http://localhost:19999" });
    await expect(adapter.synthesize("hello")).rejects.toThrow();
  }, 10_000);

  it("sends correct request to server", async () => {
    const audioBuffer = Buffer.from("fake mp3 data");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioBuffer.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new EdgeTTSAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-tts" });
    const result = await adapter.synthesize("hello world", {
      language: "en",
      voice: "en-US-AvaNeural",
      emotion: "happy",
    });

    expect(result.language).toBe("en");
    expect(result.voice).toBe("en-US-AvaNeural");
    expect(result.emotion).toBe("happy");
    expect(result.audioPath).toContain("tts-");
    expect(result.audioPath.endsWith(".mp3")).toBe(true);
  });

  it("sends correct body with all options", async () => {
    const audioBuffer = Buffer.from("fake mp3 data");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioBuffer.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new EdgeTTSAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-tts" });
    await adapter.synthesize("test", {
      language: "de",
      voice: "de-DE-KatjaNeural",
      emotion: "sad",
      rate: "-15%",
      pitch: "-3Hz",
      volume: "-10%",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text).toBe("test");
    expect(body.language).toBe("de");
    expect(body.voice).toBe("de-DE-KatjaNeural");
    expect(body.emotion).toBe("sad");
    expect(body.rate).toBe("-15%");
    expect(body.pitch).toBe("-3Hz");
    expect(body.volume).toBe("-10%");
  });

  it("handles server error response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("TTS failed"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const adapter = new EdgeTTSAdapter({ url: "http://test:9001", tmpDir: "/tmp/test-tts" });
    await expect(adapter.synthesize("hello")).rejects.toThrow("TTS synthesis failed (500)");
  });
});
