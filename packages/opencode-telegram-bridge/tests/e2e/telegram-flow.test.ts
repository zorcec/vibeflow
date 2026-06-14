/**
 * E2E tests for Telegram bot message flows.
 * Tests the complete flow from message receipt to response.
 */

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
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
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

describe("Telegram message flow e2e", () => {
  const originalEnv = { ...process.env };
  let portCounter = 20000;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_ALLOWED_USERS = "12345";
    process.env.SESSIONS_DIR = `/tmp/test-e2e-sessions-${Date.now()}`;
    portCounter++;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it("handles text message flow end-to-end", async () => {
    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({ token: "test-token", port: portCounter });

    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = (TelegramBot as any).mock.results[0].value;

    // Get the message handler
    const messageHandler = bot.on.mock.calls.find(
      (call: any[]) => call[0] === "message"
    )?.[1];

    expect(messageHandler).toBeDefined();

    // Simulate a text message
    const mockMsg = {
      chat: { id: 12345 },
      from: { id: 12345 },
      text: "Hello bot",
      message_id: 1,
    };

    await messageHandler(mockMsg);

    // Should have sent a status message
    expect(bot.sendMessage).toHaveBeenCalled();

    instance.stop();
  });

  it("handles voice message flow end-to-end", async () => {
    const mockSTT: STTAdapter = {
      name: "mock-stt",
      transcribe: vi.fn().mockResolvedValue({
        text: "hello world",
        emotion: "happy",
        language: "en",
      }),
    };

    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({
      token: "test-token",
      stt: mockSTT,
      port: portCounter,
    });

    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = (TelegramBot as any).mock.results[0].value;

    // Get the message handler
    const messageHandler = bot.on.mock.calls.find(
      (call: any[]) => call[0] === "message"
    )?.[1];

    // Simulate a voice message
    const mockMsg = {
      chat: { id: 12345 },
      from: { id: 12345 },
      voice: {
        file_id: "voice-file-id",
        mime_type: "audio/ogg",
      },
      message_id: 1,
    };

    // Mock fetch for file info and download
    let fetchCallCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      fetchCallCount++;
      if (url.includes("getFile")) {
        // First call: get file info
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { file_path: "voice/file.ogg" } }),
        };
      } else if (url.includes("file/bot")) {
        // Second call: download file
        return {
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
        };
      }
      return { ok: false };
    });
    vi.stubGlobal("fetch", mockFetch);

    await messageHandler(mockMsg);

    // Should have called STT
    expect(mockSTT.transcribe).toHaveBeenCalled();

    instance.stop();
  });

  it("handles photo message flow end-to-end", async () => {
    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({ token: "test-token", port: portCounter });

    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = (TelegramBot as any).mock.results[0].value;

    // Get the message handler
    const messageHandler = bot.on.mock.calls.find(
      (call: any[]) => call[0] === "message"
    )?.[1];

    // Simulate a photo message
    const mockMsg = {
      chat: { id: 12345 },
      from: { id: 12345 },
      photo: [
        { file_id: "photo-small", width: 100, height: 100 },
        { file_id: "photo-large", width: 800, height: 600 },
      ],
      caption: "Add this receipt",
      message_id: 1,
    };

    // Mock fetch for file download
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: { file_path: "photos/receipt.jpg" } }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
    });
    vi.stubGlobal("fetch", mockFetch);

    await messageHandler(mockMsg);

    // Should have processed the photo
    expect(bot.sendMessage).toHaveBeenCalled();

    instance.stop();
  });

  it("handles /start command", async () => {
    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({ token: "test-token", port: portCounter });

    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = (TelegramBot as any).mock.results[0].value;

    // Get the message handler
    const messageHandler = bot.on.mock.calls.find(
      (call: any[]) => call[0] === "message"
    )?.[1];

    // Simulate /start command
    const mockMsg = {
      chat: { id: 12345 },
      from: { id: 12345 },
      text: "/start",
      message_id: 1,
    };

    await messageHandler(mockMsg);

    // Should have sent welcome message
    expect(bot.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.any(String),
      { parse_mode: "MarkdownV2" }
    );

    instance.stop();
  });

  it("handles /model command", async () => {
    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({ token: "test-token", port: portCounter });

    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = (TelegramBot as any).mock.results[0].value;

    // Get the message handler
    const messageHandler = bot.on.mock.calls.find(
      (call: any[]) => call[0] === "message"
    )?.[1];

    // Simulate /model command
    const mockMsg = {
      chat: { id: 12345 },
      from: { id: 12345 },
      text: "/model",
      message_id: 1,
    };

    await messageHandler(mockMsg);

    // Should have sent model selection keyboard
    expect(bot.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.any(String),
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.any(Array),
        }),
      })
    );

    instance.stop();
  });

  it("handles /status command", async () => {
    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({ token: "test-token", port: portCounter });

    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = (TelegramBot as any).mock.results[0].value;

    // Get the message handler
    const messageHandler = bot.on.mock.calls.find(
      (call: any[]) => call[0] === "message"
    )?.[1];

    // Simulate /status command
    const mockMsg = {
      chat: { id: 12345 },
      from: { id: 12345 },
      text: "/status",
      message_id: 1,
    };

    await messageHandler(mockMsg);

    // Should have sent status
    expect(bot.sendMessage).toHaveBeenCalled();

    instance.stop();
  });

  it("rejects unauthorized users", async () => {
    process.env.TELEGRAM_ALLOWED_USERS = "99999"; // Different user

    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({ token: "test-token", port: portCounter });

    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = (TelegramBot as any).mock.results[0].value;

    // Get the message handler
    const messageHandler = bot.on.mock.calls.find(
      (call: any[]) => call[0] === "message"
    )?.[1];

    // Simulate message from unauthorized user
    const mockMsg = {
      chat: { id: 12345 },
      from: { id: 12345 },
      text: "Hello",
      message_id: 1,
    };

    await messageHandler(mockMsg);

    // Should have sent access denied
    expect(bot.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("Access denied")
    );

    instance.stop();
  });

  it("handles callback queries for model switching", async () => {
    const { createBot } = await import("../../src/bot.js");
    const instance = await createBot({ token: "test-token", port: portCounter });

    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = (TelegramBot as any).mock.results[0].value;

    // Get the callback query handler
    const callbackHandler = bot.on.mock.calls.find(
      (call: any[]) => call[0] === "callback_query"
    )?.[1];

    expect(callbackHandler).toBeDefined();

    // Simulate callback query for model selection
    const mockQuery = {
      id: "query-123",
      data: "model:opencode-go/mimo-v2.5",
      message: { chat: { id: 12345 } },
    };

    await callbackHandler(mockQuery);

    // Should have answered callback and sent confirmation
    expect(bot.answerCallbackQuery).toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalled();

    instance.stop();
  });
});

describe("Adapter integration e2e", () => {
  it("SenseVoice adapter transcribes audio correctly", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        text: "hello world",
        emotion: "happy",
        language: "en",
        audio_events: [],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { SenseVoiceSTTAdapter } = await import("../../src/adapters/sensevoice-stt.js");
    const adapter = new SenseVoiceSTTAdapter({ url: "http://test:9001", tmpDir: "/tmp/test" });

    const result = await adapter.transcribe(Buffer.from("audio data"), "audio/wav");

    expect(result.text).toBe("hello world");
    expect(result.emotion).toBe("happy");
    expect(result.language).toBe("en");
  });

  it("Edge TTS adapter synthesizes speech correctly", async () => {
    const audioBuffer = Buffer.from("mp3-audio-data");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioBuffer.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { EdgeTTSAdapter } = await import("../../src/adapters/edge-tts.js");
    const adapter = new EdgeTTSAdapter({ url: "http://test:9001", tmpDir: "/tmp/test" });

    const result = await adapter.synthesize("Hello world", { language: "en" });

    expect(result.audioPath).toContain("tts-");
    expect(result.language).toBe("en");
  });

  it("dynamic adapter loading resolves built-in adapters", async () => {
    const { loadSTT, loadTTS } = await import("../../src/adapter-loader.js");

    const stt = await loadSTT("sensevoice");
    expect(stt.name).toBe("sensevoice");
    expect(typeof stt.transcribe).toBe("function");

    const tts = await loadTTS("edge-tts");
    expect(tts.name).toBe("edge-tts");
    expect(typeof tts.synthesize).toBe("function");
  });
});

describe("Session management e2e", () => {
  it("creates and retrieves sessions correctly", async () => {
    // Set SESSIONS_DIR before importing the module
    const testDir = `/tmp/test-sessions-${Date.now()}`;
    process.env.SESSIONS_DIR = testDir;

    // Clear module cache to get fresh import with new SESSIONS_DIR
    vi.resetModules();
    const { getOrCreateSession, updateSession, deleteSession } = await import(
      "../../src/telegram/session-manager.js"
    );

    // Create a session (chatId must be numeric)
    const session = getOrCreateSession("12345", "test-model");
    expect(session).toBeDefined();
    expect(session.model).toBe("test-model");

    // Update session
    updateSession("12345", { sessionId: "new-session-id" });
    const updated = getOrCreateSession("12345", "test-model");
    expect(updated.sessionId).toBe("new-session-id");

    // Delete session
    deleteSession("12345");
  });
});
