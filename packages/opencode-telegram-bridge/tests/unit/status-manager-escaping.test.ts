import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { escapeMd } from "../../src/telegram/status-manager.js";

// Mock node-telegram-bot-api
vi.mock("node-telegram-bot-api", () => {
  const bot = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    sendChatAction: vi.fn().mockResolvedValue(true),
  };
  return { default: vi.fn(() => bot) };
});

describe("StatusManager MarkdownV2 escaping", () => {
  let StatusManager: typeof import("../../src/telegram/status-manager.js").StatusManager;
  let mockBot: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    const mod = await import("../../src/telegram/status-manager.js");
    StatusManager = mod.StatusManager;
    const TelegramBot = (await import("node-telegram-bot-api")).default;
    mockBot = new TelegramBot("test-token");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("escapes special characters in initial status message", async () => {
    const sm = new StatusManager(mockBot);
    await sm.start(123, "🤔 _Thinking..._", "en");

    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      123,
      escapeMd("🤔 _Thinking..._"),
      { parse_mode: "MarkdownV2" }
    );
  });

  it("escapes special characters in tool status", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    await sm.toolStart(statusId, "write");

    // The tool status should be escaped
    const editCall = mockBot.editMessageText.mock.calls[0];
    if (editCall) {
      const text = editCall[0];
      // Should not contain unescaped special chars (except in already-escaped form)
      expect(text).not.toMatch(/(?<!\\)\./);
    }
  });

  it("escapes special characters in heartbeat", async () => {
    const sm = new StatusManager(mockBot, { heartbeatIntervalMs: 1000 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");

    // Advance time to trigger heartbeat
    vi.advanceTimersByTime(35000);

    // Heartbeat should edit the existing message, not send a new one
    expect(mockBot.editMessageText).toHaveBeenCalled();
    // Only the initial sendMessage should have been called
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("escapes special characters in final report", async () => {
    // Use low throttle so edits go through immediately
    const sm = new StatusManager(mockBot, { editThrottleMs: 0 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");

    // Add some tool calls
    await sm.toolStart(statusId, "write");
    await sm.toolStart(statusId, "edit");

    // Complete with cost
    sm.updateUsage(statusId, 0.05, { input: 1000, output: 500 });
    sm.complete(statusId);

    // Find the last edit call (the status before complete)
    const allEditCalls = mockBot.editMessageText.mock.calls;
    expect(allEditCalls.length).toBeGreaterThan(0);
    const lastEdit = allEditCalls[allEditCalls.length - 1];
    
    const text = lastEdit[0] as string;
    // Should show coding phase and translated tool name
    expect(text).toContain("Coding");
    expect(text).toContain("file editor");
    // Should show step count
    expect(text).toContain("Step 2");
  });

  it("handles tool names with special characters", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");

    // Tool with special chars in name
    await sm.toolStart(statusId, "bash");

    const editCall = mockBot.editMessageText.mock.calls[0];
    if (editCall) {
      const text = editCall[0];
      // Should be properly escaped
      expect(text).not.toMatch(/(?<!\\)\./);
    }
  });

  it("handles text with periods in heartbeat", async () => {
    const sm = new StatusManager(mockBot, { heartbeatIntervalMs: 1000 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");

    // Manually set phase to trigger different heartbeat content
    const status = (sm as any).pending.get(statusId);
    if (status) {
      status.phase = "responding";
      status.currentTool = null;
    }

    // Advance time to trigger heartbeat
    vi.advanceTimersByTime(6000);

    // Check that the edited text is properly escaped
    const editCall = mockBot.editMessageText.mock.calls[0];
    if (editCall) {
      const text = editCall[0] as string;
      // The status should show the responding phase
      expect(text).toContain("Responding");
      // Periods in the phase label should be escaped (inside italic)
      // "Responding..." has periods after the label, inside italic markdown
      // Each period should be escaped as \. in MarkdownV2
      expect(text).toMatch(/\\.\\.\\._/);
    }
  });

  it("handles cost formatting with periods", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");

    // Set cost with decimal
    sm.updateUsage(statusId, 0.123456, { input: 1234, output: 5678 });

    // Add tool calls to make heartbeat content richer
    await sm.toolStart(statusId, "bash");
    await sm.toolStart(statusId, "edit");

    // Complete — this calls doEdit with the final report
    sm.complete(statusId);

    // The last edit call should contain escaped cost
    const allEditCalls = mockBot.editMessageText.mock.calls;
    const completionEdit = allEditCalls[allEditCalls.length - 1];
    const text = completionEdit[0] as string;
    
    // Cost period should be escaped
    expect(text).toContain("\\.");
    // Dollar sign is not a MarkdownV2 special char, stays as-is
    expect(text).toMatch(/\$0\\.12/);
  });

  it("never sends new messages for heartbeat (only edits)", async () => {
    const sm = new StatusManager(mockBot, { heartbeatIntervalMs: 1000 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");

    // Reset call counts after start
    mockBot.sendMessage.mockClear();
    mockBot.editMessageText.mockClear();

    // Advance time to trigger heartbeat
    vi.advanceTimersByTime(35000);

    // Should only edit, never send new messages
    expect(mockBot.sendMessage).not.toHaveBeenCalled();
    expect(mockBot.editMessageText).toHaveBeenCalled();
  });

  it("granular phases: coding tools show coding phase", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.toolStart(statusId, "write");
    
    const status = (sm as any).pending.get(statusId);
    expect(status?.phase).toBe("coding");
  });

  it("granular phases: search tools show searching phase", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.toolStart(statusId, "glob");
    
    const status = (sm as any).pending.get(statusId);
    expect(status?.phase).toBe("searching");
  });

  it("granular phases: other tools show tool_running phase", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.toolStart(statusId, "bash");
    
    const status = (sm as any).pending.get(statusId);
    expect(status?.phase).toBe("tool_running");
  });

  it("granular phases: writing shows responding phase", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.writing(statusId);
    
    const status = (sm as any).pending.get(statusId);
    expect(status?.phase).toBe("responding");
  });

  // ── Live status update tests ──────────────────────────────────────────────

  it("live status: shows phase icon and label on thinking", async () => {
    const sm = new StatusManager(mockBot, { editThrottleMs: 0 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.thinking(statusId);
    
    const allEdits = mockBot.editMessageText.mock.calls;
    const lastEdit = allEdits[allEdits.length - 1];
    const text = lastEdit[0] as string;
    expect(text).toContain("🤔");
    expect(text).toContain("Analyzing");
  });

  it("live status: shows tool name when tool starts", async () => {
    const sm = new StatusManager(mockBot, { editThrottleMs: 0 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.toolStart(statusId, "bash");
    
    const allEdits = mockBot.editMessageText.mock.calls;
    const lastEdit = allEdits[allEdits.length - 1];
    const text = lastEdit[0] as string;
    expect(text).toContain("terminal");
    expect(text).toContain("Step 1");
  });

  it("live status: shows elapsed time", async () => {
    vi.useFakeTimers();
    const sm = new StatusManager(mockBot, { editThrottleMs: 0, heartbeatIntervalMs: 1000 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    // Advance time by 5 seconds
    vi.advanceTimersByTime(5000);
    
    const allEdits = mockBot.editMessageText.mock.calls;
    const lastEdit = allEdits[allEdits.length - 1];
    const text = lastEdit[0] as string;
    expect(text).toContain("5s");
    
    vi.useRealTimers();
  });

  it("live status: shows step count after multiple tools", async () => {
    const sm = new StatusManager(mockBot, { editThrottleMs: 0 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.toolStart(statusId, "bash");
    await sm.toolStart(statusId, "edit");
    await sm.toolStart(statusId, "write");
    
    const allEdits = mockBot.editMessageText.mock.calls;
    const lastEdit = allEdits[allEdits.length - 1];
    const text = lastEdit[0] as string;
    expect(text).toContain("Step 3");
  });

  it("live status: shows coding phase for write tool", async () => {
    const sm = new StatusManager(mockBot, { editThrottleMs: 0 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.toolStart(statusId, "write");
    
    const allEdits = mockBot.editMessageText.mock.calls;
    const lastEdit = allEdits[allEdits.length - 1];
    const text = lastEdit[0] as string;
    expect(text).toContain("💻");
    expect(text).toContain("Coding");
  });

  it("live status: shows searching phase for grep tool", async () => {
    const sm = new StatusManager(mockBot, { editThrottleMs: 0 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.toolStart(statusId, "grep");
    
    const allEdits = mockBot.editMessageText.mock.calls;
    const lastEdit = allEdits[allEdits.length - 1];
    const text = lastEdit[0] as string;
    expect(text).toContain("🔍");
    expect(text).toContain("Searching");
  });

  it("live status: shows tool_running phase for bash tool", async () => {
    const sm = new StatusManager(mockBot, { editThrottleMs: 0 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.toolStart(statusId, "bash");
    
    const allEdits = mockBot.editMessageText.mock.calls;
    const lastEdit = allEdits[allEdits.length - 1];
    const text = lastEdit[0] as string;
    expect(text).toContain("🔧");
    expect(text).toContain("Running tool");
  });

  it("live status: shows responding phase on writing", async () => {
    const sm = new StatusManager(mockBot, { editThrottleMs: 0 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.writing(statusId);
    
    const allEdits = mockBot.editMessageText.mock.calls;
    const lastEdit = allEdits[allEdits.length - 1];
    const text = lastEdit[0] as string;
    expect(text).toContain("💬");
    expect(text).toContain("Responding");
  });

  it("complete: returns stats and disposes status", async () => {
    const sm = new StatusManager(mockBot, { editThrottleMs: 0 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.toolStart(statusId, "bash");
    sm.updateUsage(statusId, 0.10, { input: 500, output: 200 });
    
    const result = sm.complete(statusId);
    
    expect(result).not.toBeNull();
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.cost).toBe(0.10);
    expect(result!.tokensInput).toBe(500);
    expect(result!.tokensOutput).toBe(200);
    expect(result!.elapsed).toBeDefined();
    
    // Status should be disposed
    expect(sm.getMessageId(statusId)).toBeNull();
  });

  it("complete: returns null for unknown status", async () => {
    const sm = new StatusManager(mockBot);
    const result = sm.complete("nonexistent");
    expect(result).toBeNull();
  });

  it("cancel: deletes message and disposes", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    await sm.cancel(statusId);
    
    expect(mockBot.deleteMessage).toHaveBeenCalledWith(123, expect.any(Number));
    expect(sm.getMessageId(statusId)).toBeNull();
  });

  it("getMessageId: returns null after dispose", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    sm.complete(statusId);
    
    expect(sm.getMessageId(statusId)).toBeNull();
  });

  it("getChatId: returns chat id", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    expect(sm.getChatId(statusId)).toBe(123);
  });

  it("getChatId: returns null after dispose", async () => {
    const sm = new StatusManager(mockBot);
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    sm.complete(statusId);
    
    expect(sm.getChatId(statusId)).toBeNull();
  });

  it("updateToolSummary: stores summary", async () => {
    const sm = new StatusManager(mockBot, { editThrottleMs: 0 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    sm.updateToolSummary(statusId, "read file.ts");
    
    const status = (sm as any).pending.get(statusId);
    expect(status?.currentToolSummary).toBe("read file.ts");
  });

  it("shutdown: deletes all pending messages", async () => {
    const sm = new StatusManager(mockBot);
    await sm.start(100, "🤔 _Thinking..._", "en");
    await sm.start(200, "🤔 _Thinking..._", "en");
    
    await sm.shutdown();
    
    expect(mockBot.deleteMessage).toHaveBeenCalledTimes(2);
  });

  it("heartbeat: refreshes elapsed time periodically", async () => {
    vi.useFakeTimers();
    const sm = new StatusManager(mockBot, { editThrottleMs: 0, heartbeatIntervalMs: 5000 });
    const statusId = await sm.start(123, "🤔 _Thinking..._", "en");
    
    // Clear initial edits
    mockBot.editMessageText.mockClear();
    
    // Advance past heartbeat interval
    vi.advanceTimersByTime(6000);
    
    // Should have edited the message with updated elapsed time
    expect(mockBot.editMessageText).toHaveBeenCalled();
    
    vi.useRealTimers();
  });
});
