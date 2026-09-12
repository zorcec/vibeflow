import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  createSocket,
  useCollab,
  REALTIME_PATH,
  SERVER_EVENT,
  type CollabEvent,
  type RealtimeSocket,
  type TransportOptions,
} from "../socket";

/**
 * Fake transport standing in for Socket.IO: records the wire messages and lets
 * the test drive `connect` / ack / server events.
 */
function createFakeTransport(joinAccepted = true): {
  socket: RealtimeSocket;
  emitted: Array<{ event: string; args: unknown[] }>;
  options: TransportOptions[];
  connect: () => void;
  fire: (event: string, ...args: unknown[]) => void;
  isDisconnected: () => boolean;
} {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const emitted: Array<{ event: string; args: unknown[] }> = [];
  const options: TransportOptions[] = [];
  let connected = false;
  let disconnected = false;

  const socket: RealtimeSocket = {
    get connected() {
      return connected;
    },
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    emit(event, ...args) {
      emitted.push({ event, args });
      if (event === "join-workspace") {
        const ack = args[1];
        if (typeof ack === "function") {
          (ack as (joined: boolean) => void)(joinAccepted);
        }
      }
    },
    disconnect() {
      disconnected = true;
      connected = false;
    },
  };

  const fire = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };

  return {
    socket,
    emitted,
    options,
    connect: () => {
      connected = true;
      fire("connect");
    },
    fire,
    isDisconnected: () => disconnected,
  };
}

describe("createSocket", () => {
  it("uses the shared realtime path", () => {
    expect(REALTIME_PATH).toBe("/api/realtime");
  });

  it("is a no-op when no transport is provided", () => {
    const client = createSocket({ workspaceId: "board-1" });

    expect(client.connected).toBe(false);
    expect(() => client.send({ type: "typing.update" })).not.toThrow();
    expect(() => client.disconnect()).not.toThrow();
    expect(client.onEvent(() => {})).toBeInstanceOf(Function);
  });

  it("connects, joins the workspace room and forwards server events", () => {
    const transport = createFakeTransport();
    const client = createSocket({
      workspaceId: "board-1",
      url: "http://rt.test",
      createTransport: () => transport.socket,
    });

    expect(client.connected).toBe(false);
    transport.connect();

    expect(client.connected).toBe(true);
    expect(transport.emitted[0].event).toBe("join-workspace");
    expect(transport.emitted[0].args[0]).toBe("board-1");

    const received: CollabEvent[] = [];
    client.onEvent((event) => received.push(event));

    transport.fire(SERVER_EVENT, { type: "task.patch", taskId: "t1" });
    expect(received).toEqual([{ type: "task.patch", taskId: "t1" }]);

    // Malformed payloads are dropped.
    transport.fire(SERVER_EVENT, { noType: true });
    transport.fire(SERVER_EVENT, null);
    expect(received).toHaveLength(1);
  });

  it("reports a rejected join as disconnected", () => {
    const transport = createFakeTransport(false);
    const client = createSocket({
      workspaceId: "board-not-mine",
      url: "http://rt.test",
      createTransport: () => transport.socket,
    });

    transport.connect();

    expect(client.connected).toBe(false);
  });

  it("sends client events only while connected and leaves on disconnect", () => {
    const transport = createFakeTransport();
    const client = createSocket({
      workspaceId: "board-1",
      url: "http://rt.test",
      createTransport: () => transport.socket,
    });

    // Not connected yet — dropped.
    client.send({ type: "typing.update", targetId: "t1", active: true });
    expect(transport.emitted).toHaveLength(0);

    transport.connect();
    client.send({ type: "typing.update", targetId: "t1", active: true });
    expect(transport.emitted.at(-1)).toMatchObject({
      event: "typing.update",
      args: [{ type: "typing.update", targetId: "t1", active: true }],
    });

    client.disconnect();
    expect(transport.emitted.at(-1)).toMatchObject({
      event: "leave-workspace",
      args: ["board-1"],
    });
    expect(transport.isDisconnected()).toBe(true);
    expect(client.connected).toBe(false);
  });
});

describe("useCollab", () => {
  it("keeps the same interface with the transport disabled (CLI kanban)", () => {
    const transport = createFakeTransport();
    let transportsCreated = 0;

    const { result } = renderHook(() =>
      useCollab({
        workspaceId: "board-1",
        enabled: false,
        createTransport: () => {
          transportsCreated += 1;
          return transport.socket;
        },
      }),
    );

    expect(result.current.connected).toBe(false);
    expect(transportsCreated).toBe(0);

    act(() => result.current.sendEvent({ type: "typing.update" }));
    expect(transport.emitted).toHaveLength(0);
  });

  it("connects and delivers server events to subscribers", () => {
    const transport = createFakeTransport();

    const { result } = renderHook(() =>
      useCollab({
        workspaceId: "board-1",
        url: "http://rt.test",
        createTransport: () => transport.socket,
      }),
    );

    act(() => transport.connect());
    expect(result.current.connected).toBe(true);

    const received: CollabEvent[] = [];
    act(() => {
      result.current.onEvent((event) => received.push(event));
    });

    act(() => transport.fire(SERVER_EVENT, { type: "presence.join" }));
    expect(received).toEqual([{ type: "presence.join" }]);
  });
});
