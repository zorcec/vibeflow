/**
 * Envelope tests (ADR-0006): the ONE builder, its literal version, and the
 * drift pin — no other module may assemble or version an envelope.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_SCHEMA_VERSION,
  buildHookEnvelope,
} from "../../../src/core/hooks/envelope.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/unit/hooks/ → packages/cli/src
const SRC_DIR = join(HERE, "..", "..", "..", "src");

describe("buildHookEnvelope", () => {
  it("builds the 6 shared fields plus event/phase-typed payload", () => {
    const envelope = buildHookEnvelope({
      event: "task.update",
      phase: "after",
      boardId: null,
      actor: "agent",
      payload: { taskId: "abc", changed: ["status"] },
    });
    expect(envelope).toEqual({
      schemaVersion: 1,
      event: "task.update",
      phase: "after",
      boardId: null,
      actor: "agent",
      ts: expect.any(String),
      payload: { taskId: "abc", changed: ["status"] },
    });
    // ts is ISO-8601.
    expect(Number.isNaN(Date.parse(envelope.ts))).toBe(false);
  });

  it("boardId is null locally (ADR-0006)", () => {
    const envelope = buildHookEnvelope({
      event: "task.create",
      phase: "after",
      boardId: null,
      actor: "agent",
      payload: { task: { id: "x", title: "t", status: "todo" } },
    });
    expect(envelope.boardId).toBeNull();
  });

  it("schemaVersion is the literal 1", () => {
    expect(HOOK_SCHEMA_VERSION).toBe(1);
  });

  it("drift pin: only envelope.ts versions an envelope; only emit.ts calls the builder", () => {
    const versionedOutside: string[] = [];
    const buildersOutside: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        // Generated bundles embed unrelated third-party state (including
        // their own `schemaVersion` keys) — they are build output, not a
        // second envelope assembly point.
        if (entry.name.endsWith(".gen.ts")) continue;
        const isEnvelope = path.endsWith(join("core", "hooks", "envelope.ts"));
        const isEmit = path.endsWith(join("core", "hooks", "emit.ts"));
        const isTest = path.includes(`${join("tests", "unit", "hooks")}${""}`) || path.endsWith(".test.ts");
        const text = readFileSync(path, "utf8");
        if (/schemaVersion\s*:/.test(text) && !isEnvelope) {
          versionedOutside.push(path);
        }
        if (/buildHookEnvelope\s*\(/.test(text) && !isEnvelope && !isEmit && !isTest) {
          buildersOutside.push(path);
        }
      }
    };
    walk(SRC_DIR);
    expect(versionedOutside).toEqual([]);
    expect(buildersOutside).toEqual([]);
  });
});
