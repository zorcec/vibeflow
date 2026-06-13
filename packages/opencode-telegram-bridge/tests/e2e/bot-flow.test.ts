import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { STTAdapter, TTSAdapter } from "../../src/types.js";

// Mock node-telegram-bot-api
vi.mock("node-telegram-bot-api", () => {
  const bot = {
    setMyCommands: vi.fn().mockResolvedValue(true),
    on: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
    sendVoice: vi.fn().mockResolvedValue(true),
    stopPolling: vi.fn(),
  };
  return { default: vi.fn(() => bot) };
});

// Mock the OpenCode client
vi.mock("../../src/telegram/opencode-client.js", () => ({
  ocHealth: vi.fn().mockResolvedValue({ connected: true, version: "1.0.0" }),
  ocCreateSession: vi.fn().mockResolvedValue({ id: "session-123", title: "test" }),
  ocSendMessage: vi.fn().mockResolvedValue({
    parts: [{ type: "text", text: "Hello from OpenCode!" }],
  }),
  ocListSessions: vi.fn().mockResolvedValue([]),
  ocDeleteSession: vi.fn().mockResolvedValue(undefined),
  ocGetMessages: vi.fn().mockResolvedValue([]),
  ocListProviders: vi.fn().mockResolvedValue([]),
  ocAbortSession: vi.fn().mockResolvedValue(undefined),
  ocSubscribeEvents: vi.fn().mockReturnValue(() => {}),
  parseModel: vi.fn().mockReturnValue({ providerID: "opencode-go", modelID: "mimo-v2.5" }),
}));

describe("createBot e2e", () => {
  const originalEnv = { ...process.env };
  let portCounter = 10000;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.SESSIONS_DIR = `/tmp/test-e2e-sessions-${Date.now()}`;
    portCounter++;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it("creates bot instance with defaults", async () => {
    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({ token: "test-token", port: portCounter });

    expect(instance.bot).toBeDefined();
    expect(typeof instance.stop).toBe("function");
    instance.stop();
  });

  it("creates bot with custom config", async () => {
    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({
      token: "custom-token",
      opencodeUrl: "http://custom:4096",
      defaultModel: "custom/model",
      port: portCounter,
    });

    expect(instance.bot).toBeDefined();
    instance.stop();
  });

  it("creates bot with custom STT adapter", async () => {
    const mockSTT: STTAdapter = {
      name: "mock-stt",
      transcribe: vi.fn().mockResolvedValue({ text: "test transcription" }),
    };

    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({
      token: "test-token",
      stt: mockSTT,
      port: portCounter,
    });

    expect(instance.bot).toBeDefined();
    instance.stop();
  });

  it("creates bot with custom TTS adapter", async () => {
    const mockTTS: TTSAdapter = {
      name: "mock-tts",
      synthesize: vi.fn().mockResolvedValue({ audioPath: "/tmp/test.mp3", language: "en" }),
    };

    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({
      token: "test-token",
      tts: mockTTS,
      port: portCounter,
    });

    expect(instance.bot).toBeDefined();
    instance.stop();
  });

  it("creates bot with both adapters", async () => {
    const mockSTT: STTAdapter = {
      name: "mock-stt",
      transcribe: vi.fn().mockResolvedValue({ text: "test" }),
    };
    const mockTTS: TTSAdapter = {
      name: "mock-tts",
      synthesize: vi.fn().mockResolvedValue({ audioPath: "/tmp/test.mp3", language: "en" }),
    };

    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({
      token: "test-token",
      stt: mockSTT,
      tts: mockTTS,
      port: portCounter,
    });

    expect(instance.bot).toBeDefined();
    instance.stop();
  });

  it("registers message handlers", async () => {
    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({ token: "test-token", port: portCounter });

    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = (TelegramBot as any).mock.results[0].value;

    expect(bot.on).toHaveBeenCalledWith("message", expect.any(Function));
    expect(bot.on).toHaveBeenCalledWith("callback_query", expect.any(Function));
    instance.stop();
  });

  it("registers bot commands", async () => {
    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({ token: "test-token", port: portCounter });

    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = (TelegramBot as any).mock.results[0].value;

    expect(bot.setMyCommands).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ command: "start" }),
        expect.objectContaining({ command: "help" }),
        expect.objectContaining({ command: "model" }),
      ]),
    );
    instance.stop();
  });
});

describe("adapter integration e2e", () => {
  it("SenseVoice adapter works end-to-end", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: "hello", emotion: "happy", language: "en" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { SenseVoiceSTTAdapter } = await import("../../src/adapters/sensevoice-stt.js");
    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001", tmpDir: "/tmp/test" });

    const result = await adapter.transcribe(Buffer.from("audio"), "audio/wav");
    expect(result.text).toBe("hello");
    expect(result.emotion).toBe("happy");
  });

  it("Edge TTS adapter works end-to-end", async () => {
    const audioBuffer = Buffer.from("mp3-data");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioBuffer.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { EdgeTTSAdapter } = await import("../../src/adapters/edge-tts.js");
    const adapter = new EdgeTTSAdapter({ url: "http://test:9001", tmpDir: "/tmp/test" });

    const result = await adapter.synthesize("hello", { language: "en" });
    expect(result.audioPath).toContain("tts-");
    expect(result.language).toBe("en");
  });

  it("dynamic adapter loading works", async () => {
    const { loadSTT, loadTTS } = await import("../../src/adapter-loader.js");

    const stt = await loadSTT("sensevoice");
    expect(stt.name).toBe("sensevoice");

    const tts = await loadTTS("edge-tts");
    expect(tts.name).toBe("edge-tts");
  });
});
