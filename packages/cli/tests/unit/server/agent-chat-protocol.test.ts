/**
 * Bulletproof coverage for the pi→overlay event mapper (ticket 0847833f).
 *
 * Every pi wire shape the session manager can deliver is pinned here:
 * a protocol change that alters a shape must turn a test red (loud)
 * rather than silently changing what the panel renders. Unknown and
 * malformed records map to NO events — the panel stays calm.
 */
import { describe, it, expect } from "vitest";
import { mapPiRecord } from "../../../src/server/agent-chat/protocol.js";

const SID = "sess1";

describe("mapPiRecord", () => {
  it("maps text deltas to agent:token, keeps the session id", () => {
    expect(
      mapPiRecord(SID, {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Hello ",
        },
      }),
    ).toEqual([{ type: "agent:token", sessionId: SID, delta: "Hello " }]);
  });

  it("drops empty text deltas (no empty token frames)", () => {
    expect(
      mapPiRecord(SID, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "" },
      }),
    ).toEqual([]);
  });

  it("drops thinking deltas (reasoning stays in the engine)", () => {
    expect(
      mapPiRecord(SID, {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 1,
          delta: "hmm",
        },
      }),
    ).toEqual([]);
  });

  it("drops toolcall deltas (covered by the tool_execution_* lifecycle)", () => {
    expect(
      mapPiRecord(SID, {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 2,
          delta: "{\"a\":",
        },
      }),
    ).toEqual([]);
  });

  it("drops message_update without a nested event object", () => {
    expect(mapPiRecord(SID, { type: "message_update" })).toEqual([]);
    expect(
      mapPiRecord(SID, {
        type: "message_update",
        assistantMessageEvent: "nope",
      }),
    ).toEqual([]);
  });

  it("maps tool_execution_start to a tool-call card event", () => {
    expect(
      mapPiRecord(SID, {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "a.ts" },
      }),
    ).toEqual([
      {
        type: "agent:tool-call",
        sessionId: SID,
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "a.ts" },
      },
    ]);
  });

  it("drops tool starts missing id or name (uncorrelatable cards)", () => {
    expect(
      mapPiRecord(SID, { type: "tool_execution_start", toolName: "read" }),
    ).toEqual([]);
    expect(
      mapPiRecord(SID, { type: "tool_execution_start", toolCallId: "c" }),
    ).toEqual([]);
  });

  it("maps tool_execution_end to tool-result, preserving isError", () => {
    expect(
      mapPiRecord(SID, {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "read",
        result: { content: [{ type: "text", text: "hi" }] },
        isError: false,
      }),
    ).toEqual([
      {
        type: "agent:tool-result",
        sessionId: SID,
        toolCallId: "call_1",
        result: { content: [{ type: "text", text: "hi" }] },
        isError: false,
      },
    ]);
    const [err] = mapPiRecord(SID, {
      type: "tool_execution_end",
      toolCallId: "call_2",
      result: "boom",
      isError: true,
    });
    expect(err).toMatchObject({ type: "agent:tool-result", isError: true });
  });

  it("maps agent_settled to done, preserving abort", () => {
    expect(mapPiRecord(SID, { type: "agent_settled", aborted: false })).toEqual([
      { type: "agent:done", sessionId: SID, aborted: false },
    ]);
    expect(mapPiRecord(SID, { type: "agent_settled", aborted: true })).toEqual([
      { type: "agent:done", sessionId: SID, aborted: true },
    ]);
  });

  it("maps failed responses to agent:error, ok responses to silence", () => {
    expect(
      mapPiRecord(SID, {
        type: "response",
        id: "r1",
        command: "prompt",
        success: false,
        error: "no model",
      }),
    ).toEqual([{ type: "agent:error", sessionId: SID, message: "no model" }]);
    expect(
      mapPiRecord(SID, {
        type: "response",
        id: "r2",
        command: "prompt",
        success: true,
      }),
    ).toEqual([]);
  });

  it("silences engine-room chatter and unknown future records", () => {
    for (const type of [
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "message_start",
      "message_end",
      "tool_execution_update",
      "queue_update",
      "compact_begin",
      "future_record_v9",
    ]) {
      expect(mapPiRecord(SID, { type }), `type ${type}`).toEqual([]);
    }
  });
});
