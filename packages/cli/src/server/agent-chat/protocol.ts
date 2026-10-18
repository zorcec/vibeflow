/**
 * pi → overlay event mapping (ticket 0847833f): translate RPC wire
 * records into the chat WS protocol the overlay panel renders.
 *
 * WHAT: a pure function — one pi record in, zero or more overlay events
 * out. Streaming text deltas (`message_update` → `text_delta`) become
 * `agent:token`; tool lifecycle (`tool_execution_start/end`) becomes
 * `agent:tool-call` / `agent:tool-result` cards; `agent_settled` becomes
 * `agent:done`. Everything else (thinking deltas, partial tool updates,
 * queue/compaction noise, unknown future records) maps to nothing — the
 * panel shows a calm transcript, not the engine room.
 *
 * WHY pure and total: the mapper is the highest-risk seam (a protocol
 * shape change must degrade to silence, never to a crash or a stuck
 * spinner), so it carries the bulletproof unit coverage and no I/O.
 */
import type { PiWireRecord } from "./sessions.js";

export type OverlayChatEvent =
  | { type: "agent:token"; sessionId: string; delta: string }
  | {
      type: "agent:tool-call";
      sessionId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "agent:tool-result";
      sessionId: string;
      toolCallId: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "agent:done"; sessionId: string; aborted: boolean }
  | { type: "agent:error"; sessionId: string; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Map one parsed pi wire record to overlay chat events. Never throws:
 * malformed shapes yield no events (callers already got a usable
 * diagnostic from the session's parseError path for unparseable lines;
 * well-formed-but-unexpected records are simply future protocol).
 */
export function mapPiRecord(
  sessionId: string,
  record: PiWireRecord,
): OverlayChatEvent[] {
  switch (record.type) {
    case "message_update": {
      const nested = asRecord(record.assistantMessageEvent);
      if (!nested) return [];
      // Text only: thinking deltas stay inside the engine (the panel is a
      // user transcript, not a reasoning trace) and toolcall deltas are
      // redundant with the tool_execution_* lifecycle below.
      if (nested.type !== "text_delta") return [];
      const delta = typeof nested.delta === "string" ? nested.delta : "";
      if (delta.length === 0) return [];
      return [{ type: "agent:token", sessionId, delta }];
    }
    case "tool_execution_start": {
      const toolCallId = asString(record.toolCallId);
      const toolName = asString(record.toolName);
      if (!toolCallId || !toolName) return [];
      return [
        {
          type: "agent:tool-call",
          sessionId,
          toolCallId,
          toolName,
          args: record.args ?? {},
        },
      ];
    }
    case "tool_execution_end": {
      const toolCallId = asString(record.toolCallId);
      if (!toolCallId) return [];
      return [
        {
          type: "agent:tool-result",
          sessionId,
          toolCallId,
          result: record.result ?? null,
          isError: record.isError === true,
        },
      ];
    }
    case "agent_settled": {
      return [
        {
          type: "agent:done",
          sessionId,
          aborted: record.aborted === true,
        },
      ];
    }
    case "response": {
      if (record.success === true) return [];
      const message =
        asString(record.error) ?? "pi command failed without detail";
      return [{ type: "agent:error", sessionId, message }];
    }
    default:
      // agent_start/end, turn_*, message_start/end, queue/compaction/
      // retry chatter, tool_execution_update partials, and any future
      // record: intentionally silent (see module doc).
      return [];
  }
}
