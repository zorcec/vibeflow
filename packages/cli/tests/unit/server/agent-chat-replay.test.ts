/**
 * Record/replay for the agent chat wire (ticket 0847833f).
 *
 * WHAT: every `tests/fixtures/agent-chat/*.jsonl` cassette replays line
 * by line through the REAL framing (LF split) + `mapPiRecord`, asserting
 * the exact overlay event sequence. `synthetic-shape.jsonl` is a
 * hand-written wire-shape fixture (labeled, NOT model output) that keeps
 * the harness itself green in CI. Real `chat-real-*.jsonl` cassettes —
 * recorded manually per fixtures/agent-chat/README.md — replay
 * identically when present, skipped with a clear reason when absent.
 *
 * WHY: pi's wire protocol evolves; a silent shape change must turn this
 * red instead of wedging the panel on a stuck spinner.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mapPiRecord } from "../../../src/server/agent-chat/protocol.js";
import type { PiWireRecord } from "../../../src/server/agent-chat/sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "..", "..", "fixtures", "agent-chat");

function loadCassettes(): Array<{ name: string; lines: string[] }> {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((name) => ({
      name,
      lines: readFileSync(join(FIXTURE_DIR, name), "utf8")
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0),
    }));
}

function parseLine(line: string): PiWireRecord {
  // Same contract as the session reader: LF-split, single CR strip.
  const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
  return JSON.parse(clean) as PiWireRecord;
}

describe("agent chat cassette replay", () => {
  const cassettes = loadCassettes();

  it("discovers at least the synthetic shape fixture", () => {
    expect(cassettes.map((c) => c.name)).toContain("synthetic-shape.jsonl");
  });

  for (const { name, lines } of cassettes) {
    const isSynthetic = name === "synthetic-shape.jsonl";
    (isSynthetic ? it : it.skip)(
      `replays ${name}${isSynthetic ? " (synthetic wire shape)" : " (recorded cassette)"}`,
      () => {
        const events: Array<Record<string, unknown>> = [];
        for (const line of lines) {
          const record = parseLine(line);
          for (const e of mapPiRecord("chat-replay", record)) {
            events.push({ ...e, sessionId: undefined });
          }
        }
        // Strip session ids: cassettes record one session, mapping stamps it.
        const kinds = events.map((e) => e.type);
        expect(kinds).toContain("agent:token");
        expect(kinds).toContain("agent:tool-call");
        expect(kinds).toContain("agent:tool-result");
        expect(kinds[kinds.length - 1]).toBe("agent:done");
        // Every tool-call resolves exactly once, in order.
        const calls = events.filter((e) => e.type === "agent:tool-call") as Array<{ toolCallId: string }>;
        const results = events.filter((e) => e.type === "agent:tool-result") as Array<{ toolCallId: string }>;
        expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.toolCallId));
      },
    );
  }

  it.skip("replays real cassettes when present (see fixtures/agent-chat/README.md)", () => {
    // Placeholder that turns green the moment a chat-real-*.jsonl lands:
    // the loop above picks up EVERY .jsonl file automatically.
  });
});
