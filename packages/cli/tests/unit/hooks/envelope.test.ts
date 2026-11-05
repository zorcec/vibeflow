/**
 * Envelope v2 tests (ADR-0007): tool + surface + phase: before|after, no
 * event field, null-activity invocations, and the drift pin — no other
 * module may assemble or version an envelope.
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

describe("buildHookEnvelope (v2)", () => {
  it("builds tool/surface/phase/activity/payload plus the generic contract", () => {
    const envelope = buildHookEnvelope({
      tool: "tasks",
      surface: "cli",
      activity: "task.update",
      phase: "after",
      boardId: null,
      actor: "agent",
      payload: { taskId: "abc", changed: ["status"] },
    });
    // Generic contract (owner, ADR-0007): the tool key + surface + the
    // full task snapshot (null when absent), the explicit activity enum,
    // the activity object when one exists, and the replaceable
    // instructions draft.
    expect(envelope).toEqual({
      schemaVersion: 2,
      tool: "tasks",
      surface: "cli",
      activity: "task.update",
      phase: "after",
      boardId: null,
      actor: "agent",
      ts: expect.any(String),
      payload: { taskId: "abc", changed: ["status"] },
      task: null,
      instructions: "",
    });
    // ts is ISO-8601.
    expect(Number.isNaN(Date.parse(envelope.ts))).toBe(false);
  });

  it("has no event field (it always equalled activity)", () => {
    const envelope = buildHookEnvelope({
      tool: "create_task",
      surface: "mcp",
      activity: "task.create",
      phase: "before",
      boardId: null,
      actor: "agent",
      payload: { title: "t" },
    });
    expect("event" in envelope).toBe(false);
    expect(envelope.activity).toBe("task.create");
    expect(envelope.tool).toBe("create_task");
    expect(envelope.surface).toBe("mcp");
  });

  it("phase is before|after (the pre vocabulary is gone)", () => {
    for (const phase of ["before", "after"] as const) {
      const envelope = buildHookEnvelope({
        tool: "verify",
        surface: "cli",
        activity: "verify",
        phase,
        boardId: null,
        actor: "agent",
        payload: { taskId: "x" },
      });
      expect(envelope.phase).toBe(phase);
    }
  });

  it("activity null forces payload null (reads narrate once with no effect)", () => {
    const envelope = buildHookEnvelope({
      tool: "kanban",
      surface: "cli",
      activity: null,
      phase: "after",
      boardId: null,
      actor: "agent",
      payload: null,
      activityObject: { url: "http://localhost:3700" },
    });
    expect(envelope.activity).toBeNull();
    expect(envelope.payload).toBeNull();
    expect(envelope.task).toBeNull();
    expect(envelope.activityObject).toEqual({ url: "http://localhost:3700" });
  });

  it("boardId is null locally (ADR-0007)", () => {
    const envelope = buildHookEnvelope({
      tool: "tasks",
      surface: "cli",
      activity: "task.create",
      phase: "after",
      boardId: null,
      actor: "agent",
      payload: { task: { id: "x", title: "t", status: "todo" } },
    });
    expect(envelope.boardId).toBeNull();
  });

  it("schemaVersion is the literal 2", () => {
    expect(HOOK_SCHEMA_VERSION).toBe(2);
  });

  it("threads task/activityObject/instructions when the emitter provides them", () => {
    const task = {
      id: "abc",
      title: "t",
      description: "",
      status: "todo" as const,
      selector: "/",
      created: "2026-01-01T00:00:00.000Z",
    };
    const envelope = buildHookEnvelope({
      tool: "tasks",
      surface: "cli",
      activity: "task.update",
      phase: "after",
      boardId: null,
      actor: "agent",
      payload: { taskId: "abc", changed: ["status"] },
      task,
      activityObject: { changed: ["status"] },
      instructions: "draft",
    });
    // The legacy payload is byte-identical — the generic fields ride
    // alongside it, never inside it.
    expect(envelope.payload).toEqual({ taskId: "abc", changed: ["status"] });
    expect(envelope.task).toEqual(task);
    expect(envelope.activity).toBe("task.update");
    expect(envelope.activityObject).toEqual({ changed: ["status"] });
    expect(envelope.instructions).toBe("draft");
  });

  it("omits activityObject when the emitter passes none (absent, not null)", () => {
    const envelope = buildHookEnvelope({
      tool: "push",
      surface: "cli",
      activity: "push",
      phase: "after",
      boardId: null,
      actor: "agent",
      payload: { taskCount: 1, chunkCount: 1, transport: "remote" },
    });
    expect(envelope.task).toBeNull();
    expect("activityObject" in envelope).toBe(false);
    expect(envelope.instructions).toBe("");
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
        // Public authoring shell (ADR-0007): src/hooks.ts declares the
        // envelope SHAPE for hook authors (including the schemaVersion
        // field type) but never assembles one — the builder ban below
        // stays absolute, so this allowlist cannot hide a second assembly
        // point. Parity with core is compile-pinned in hooks.ts.
        const isPublicShell = path.endsWith(join("src", "hooks.ts"));
        const isTest = path.endsWith(".test.ts");
        const text = readFileSync(path, "utf8");
        if (/schemaVersion\s*:/.test(text) && !isEnvelope && !isPublicShell) {
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
