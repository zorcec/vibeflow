/**
 * Chat view reducer coverage (ticket 0847833f): pure merge rules for WS
 * agent events — streaming flush, tool-card lifecycle, approval add/
 * remove, session scoping, unknown-type silence. No DOM, no fetch.
 */
import { describe, it, expect } from "vitest";
import {
  applyChatEvent,
  resolveChatApproval,
  emptyChatView,
} from "../../../src/client/overlay-browser/chat.js";

describe("applyChatEvent", () => {
  it("accumulates token deltas into streaming text", () => {
    let s = emptyChatView();
    s = applyChatEvent(s, { type: "agent:token", sessionId: "s1", delta: "hi " }, "s1");
    s = applyChatEvent(s, { type: "agent:token", sessionId: "s1", delta: "there" }, "s1");
    expect(s.streamingText).toBe("hi there");
    expect(s.messages).toHaveLength(0);
  });

  it("ignores other sessions and non-agent frames", () => {
    let s = applyChatEvent(emptyChatView(), { type: "agent:token", delta: "x" }, "s1");
    expect(s.streamingText).toBe("");
    s = applyChatEvent(s, { type: "agent:token", sessionId: "s2", delta: "x" }, "s1");
    expect(s.streamingText).toBe("");
    s = applyChatEvent(s, { type: "tasks-updated" }, "s1");
    expect(s).toEqual(emptyChatView());
    s = applyChatEvent(s, { type: "agent:future-type" }, "s1");
    expect(s).toEqual(emptyChatView());
  });

  it("flushes streaming text into an assistant message on done", () => {
    let s = emptyChatView();
    s = applyChatEvent(s, { type: "agent:token", sessionId: "s1", delta: "yo" }, "s1");
    s = applyChatEvent(s, { type: "agent:done", sessionId: "s1", aborted: false }, "s1");
    expect(s.streamingText).toBe("");
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: "assistant", text: "yo" });
  });

  it("done with no streamed text adds no empty message", () => {
    const s = applyChatEvent(emptyChatView(), { type: "agent:done", sessionId: "s1" }, "s1");
    expect(s.messages).toHaveLength(0);
  });

  it("tool calls attach to the streaming turn, results close the card", () => {
    let s = emptyChatView();
    s = applyChatEvent(s, { type: "agent:token", sessionId: "s1", delta: "checking " }, "s1");
    s = applyChatEvent(
      s,
      { type: "agent:tool-call", sessionId: "s1", toolCallId: "c1", toolName: "read_page_dom", args: {} },
      "s1",
    );
    // The card opens the assistant turn immediately (text still streaming);
    // done fills that same message's text so one turn stays one bubble.
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: "assistant", text: "" });
    s = applyChatEvent(
      s,
      { type: "agent:tool-result", sessionId: "s1", toolCallId: "c1", result: { ok: true }, isError: false },
      "s1",
    );
    s = applyChatEvent(s, { type: "agent:done", sessionId: "s1" }, "s1");
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.text).toBe("checking ");
    const cards = s.messages[0]!.toolCalls!;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ toolCallId: "c1", done: true, isError: false });
  });

  it("tool-only turns open their own assistant message", () => {
    let s = emptyChatView();
    s = applyChatEvent(
      s,
      { type: "agent:tool-call", sessionId: "s1", toolCallId: "c9", toolName: "bash", args: {} },
      "s1",
    );
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: "assistant", text: "" });
  });

  it("errors surface as system messages, preserving streamed text", () => {
    let s = emptyChatView();
    s = applyChatEvent(s, { type: "agent:token", sessionId: "s1", delta: "half " }, "s1");
    s = applyChatEvent(s, { type: "agent:error", sessionId: "s1", message: "boom" }, "s1");
    expect(s.streamingText).toBe("");
    expect(s.messages.map((m) => m.role)).toEqual(["assistant", "system"]);
    expect(s.messages[1]!.text).toBe("boom");
  });

  it("approval requests add idempotent cards, resolve removes them", () => {
    let s = emptyChatView();
    const card = {
      type: "agent:approval-request",
      sessionId: "s1",
      approvalId: "ap1",
      toolName: "delete_task",
      argsSummary: "{}",
    };
    s = applyChatEvent(s, card, "s1");
    s = applyChatEvent(s, card, "s1");
    expect(s.approvals).toHaveLength(1);
    s = resolveChatApproval(s, "ap1");
    expect(s.approvals).toHaveLength(0);
    // Unknown id is a no-op (same object back — cheap referential check).
    expect(resolveChatApproval(s, "nope")).toBe(s);
  });
});
