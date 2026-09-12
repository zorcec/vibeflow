"use client";

/**
 * Shared realtime collaboration client.
 *
 * One implementation is shared by the CLI kanban and network-mode surfaces;
 * only the transport differs:
 *   - network mode: Socket.IO over a configurable URL, session-authenticated
 *   - CLI kanban: single user, no collaboration — pass `enabled: false` and the
 *     whole client is a no-op (`connected` stays false, `sendEvent` does nothing)
 *
 * The transport is injected via `createTransport`, so this module never imports
 * a socket library: the CLI bundle stays free of realtime code.
 *
 * Wire contract: the client joins `workspace:<workspaceId>` and the server
 * pushes every payload on the `server-event` channel.
 */
import React from "react";

/** Socket.IO path the realtime service listens on. */
export const REALTIME_PATH = "/api/realtime";

/** Single server → client channel; every payload is a `CollabEvent`. */
export const SERVER_EVENT = "server-event";

export interface CollabEvent {
  type: string;
  [key: string]: unknown;
}

/** Minimal surface of a realtime socket — implemented by Socket.IO on web. */
export interface RealtimeSocket {
  readonly connected: boolean;
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  disconnect(): void;
}

export interface TransportOptions {
  url: string;
  path: string;
  auth?: Record<string, unknown>;
}

export type CreateTransport = (options: TransportOptions) => RealtimeSocket;

export interface CreateSocketOptions {
  /** Room to join — the board/workspace id. */
  workspaceId: string;
  /** Endpoint override; defaults to the current origin in the browser. */
  url?: string;
  /** Auth payload handed to the transport (Socket.IO `auth`). */
  auth?: Record<string, unknown>;
  /** Transport factory. Omit (or set `enabled: false`) for a no-op client. */
  createTransport?: CreateTransport;
  /** False disables the transport entirely — single-user surfaces. */
  enabled?: boolean;
}

export interface CollabSocket {
  readonly connected: boolean;
  send(event: CollabEvent): void;
  onEvent(handler: (event: CollabEvent) => void): () => void;
  onStatus(handler: (connected: boolean) => void): () => void;
  disconnect(): void;
}

function isCollabEvent(value: unknown): value is CollabEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * Create a collaboration client for one workspace room.
 *
 * With no `createTransport` (or `enabled: false`) every method is a no-op, so
 * single-user surfaces share the exact same interface without a transport.
 */
export function createSocket(options: CreateSocketOptions): CollabSocket {
  const { workspaceId, enabled = true, createTransport } = options;
  const url =
    options.url ??
    (typeof window === "undefined" ? "" : window.location.origin);

  const eventHandlers = new Set<(event: CollabEvent) => void>();
  const statusHandlers = new Set<(connected: boolean) => void>();
  let connected = false;
  let socket: RealtimeSocket | null = null;

  const setConnected = (next: boolean): void => {
    if (connected === next) return;
    connected = next;
    for (const handler of statusHandlers) handler(next);
  };

  if (enabled && createTransport && workspaceId) {
    socket = createTransport({
      url,
      path: REALTIME_PATH,
      auth: options.auth,
    });

    socket.on("connect", () => {
      setConnected(true);
      // The server verifies board membership; a rejected join means the socket
      // never receives room events and is reported as disconnected.
      socket?.emit("join-workspace", workspaceId, (joined: boolean) => {
        if (!joined) setConnected(false);
      });
    });

    socket.on("disconnect", () => setConnected(false));

    socket.on(SERVER_EVENT, (event: unknown) => {
      if (!isCollabEvent(event)) return;
      for (const handler of eventHandlers) handler(event);
    });
  }

  return {
    get connected() {
      return connected;
    },
    send(event) {
      if (!socket?.connected) return;
      socket.emit(event.type, event);
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      handler(connected);
      return () => statusHandlers.delete(handler);
    },
    disconnect() {
      socket?.emit("leave-workspace", workspaceId);
      socket?.disconnect();
      socket = null;
      setConnected(false);
    },
  };
}

export interface UseCollabOptions extends CreateSocketOptions {}

export interface UseCollabResult {
  connected: boolean;
  sendEvent: (event: CollabEvent) => void;
  onEvent: (handler: (event: CollabEvent) => void) => () => void;
}

/**
 * React binding for {@link createSocket}. Shared by network-mode surfaces and
 * the CLI kanban (the latter with `enabled: false`).
 */
export function useCollab(options: UseCollabOptions): UseCollabResult {
  const { workspaceId, enabled = true, url } = options;
  const [connected, setConnected] = React.useState(false);
  const socketRef = React.useRef<CollabSocket | null>(null);
  const handlersRef = React.useRef(new Set<(event: CollabEvent) => void>());
  // `createTransport` / `auth` only matter at (re)connect time; keep the latest
  // render's options without making them effect dependencies.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  React.useEffect(() => {
    if (!enabled || !workspaceId) return;

    const socket = createSocket(optionsRef.current);
    socketRef.current = socket;
    // Re-register existing subscribers so they survive a room change.
    const unsubscribers = [...handlersRef.current].map((handler) =>
      socket.onEvent(handler),
    );
    const unsubscribeStatus = socket.onStatus(setConnected);

    return () => {
      unsubscribeStatus();
      for (const unsubscribe of unsubscribers) unsubscribe();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [workspaceId, enabled, url]);

  const sendEvent = React.useCallback((event: CollabEvent) => {
    socketRef.current?.send(event);
  }, []);

  const onEvent = React.useCallback((handler: (event: CollabEvent) => void) => {
    handlersRef.current.add(handler);
    const unsubscribe = socketRef.current?.onEvent(handler);
    return () => {
      handlersRef.current.delete(handler);
      unsubscribe?.();
    };
  }, []);

  return { connected, sendEvent, onEvent };
}
