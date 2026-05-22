import { describe, it, expect } from "vitest";
import type {
  ClientEvent,
  ServerEvent,
  RedisEnvelope,
  UserPresence,
} from "@vibeflow-tools/shared";

describe("@vibeflow/shared collab-types", () => {
  it("ClientEvent union types are constructible", () => {
    const presenceJoin: ClientEvent = {
      type: "presence.join",
      roomKey: "workspace:w1:project:p1:board:b1",
      user: {
        userId: "u1",
        name: "Alice",
        color: "hsl(120, 70%, 55%)",
        currentPath: "/board",
      },
    };
    expect(presenceJoin.type).toBe("presence.join");

    const cursorUpdate: ClientEvent = {
      type: "cursor.update",
      roomKey: "workspace:w1:project:p1:board:b1",
      x: 100,
      y: 200,
    };
    expect(cursorUpdate.type).toBe("cursor.update");

    const typingUpdate: ClientEvent = {
      type: "typing.update",
      roomKey: "workspace:w1:project:p1:board:b1",
      targetId: "task-1",
      active: true,
    };
    expect(typingUpdate.type).toBe("typing.update");
  });

  it("ServerEvent union types are constructible", () => {
    const taskPatch: ServerEvent = {
      type: "task.patch",
      taskId: "t1",
      patch: { title: "Updated" },
      actorId: "u1",
    };
    expect(taskPatch.type).toBe("task.patch");

    const errorEvent: ServerEvent = {
      type: "error",
      message: "Something went wrong",
    };
    expect(errorEvent.type).toBe("error");
  });

  it("RedisEnvelope wraps server events", () => {
    const envelope: RedisEnvelope = {
      roomKey: "workspace:w1:project:p1:board:b1",
      event: { type: "presence.leave", userId: "u1" },
      sourceId: "inst-abc",
    };
    expect(envelope.event.type).toBe("presence.leave");
    expect(envelope.sourceId).toBe("inst-abc");
  });

  it("UserPresence has all required fields", () => {
    const presence: UserPresence = {
      userId: "u1",
      name: "Bob",
      color: "hsl(240, 70%, 55%)",
      currentPath: "/dashboard",
    };
    expect(presence.userId).toBe("u1");
    expect(presence.name).toBe("Bob");
    expect(presence.color).toMatch(/^hsl\(/);
    expect(presence.currentPath).toBe("/dashboard");
  });
});
