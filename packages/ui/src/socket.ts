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

/**
 * Heartbeat/baseline subtype: the server's current per-board data revision
 * with no payload. Mirrors `BOARD_REVISION_EVENT_TYPE` in
 * `@vibeflow-tools/shared` — repeated literally here because this package
 * never imports the wire contract (keeps the CLI bundle free of it), the
 * same reason `PresenceArea` is mirrored in `kanban/types.ts`. Change both
 * if the wire string ever changes.
 */
export const BOARD_REVISION_EVENT_TYPE = "board.revision";

/**
 * A missed event detected WITHOUT any reconnect (ticket cb3d0506).
 *
 * The server numbers every durable board mutation with a 1-based per-board
 * `rev` (see `board.revision` in `@vibeflow-tools/shared`). A data event
 * whose `rev` jumps by more than one since the previous sighting proves an
 * intermediate event was lost while this socket stayed up; a heartbeat past
 * the previous sighting proves the same for a loss with no later traffic
 * (a single missed event shows as exactly one ahead — invisible to the
 * jump rule). Either way the reconnect resync can never fire for it, so
 * the consumer must re-fetch instead of trusting its event stream.
 */
export interface RevisionGap {
  /** The revision just seen (data event or `board.revision` heartbeat). */
  rev: number;
  /** The newest revision previously seen — everything after it is suspect. */
  lastSeen: number;
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
  /**
   * Fires once per TRUE reconnect: a false → true transition after the
   * client has connected at least once. Never fires on the initial
   * connect (the first query fetch already covers that), and never on a
   * timer — there is deliberately no polling in this module. Consumers
   * (e.g. the kanban board) use it for ONE bounded resync per reconnect,
   * so a broadcast lost while the socket was down cannot leave the
   * session silently stale.
   */
  onReconnect(handler: () => void): () => void;
  /**
   * Fires once per detected revision gap: a seen `rev` exceeds the previous
   * sighting by more than one. The first `rev` ever seen only baselines (an
   * older server never sends one; a fresh join fetches anyway). Replays and
   * duplicates never fire. Deliberately timer-free — the signal rides the
   * realtime channel (data events plus the server's `board.revision`
   * heartbeat), never a poll. Consumers run ONE bounded resync per gap.
   */
  onGap(handler: (gap: RevisionGap) => void): () => void;
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
  const reconnectHandlers = new Set<() => void>();
  const gapHandlers = new Set<(gap: RevisionGap) => void>();
  // Newest board `rev` seen on this socket, or null before the first one.
  // Reset on every (re)connect: the server re-baselines the joiner right
  // after `join-workspace`, so tracking restarts clean instead of comparing
  // a fresh counter (e.g. after a ws restart) against a stale sighting —
  // which would deafen the detector forever. The `onReconnect` resync
  // covers whatever was missed during the downtime itself.
  let lastRev: number | null = null;
  let connected = false;
  // True once the first connect completes. Distinguishes the initial
  // connect (queries fetch on mount — no resync needed) from a reconnect
  // (the stream may have dropped events — exactly one resync per return).
  let everConnected = false;
  let socket: RealtimeSocket | null = null;

  const setConnected = (next: boolean): void => {
    if (connected === next) return;
    connected = next;
    if (next) {
      if (everConnected) {
        for (const handler of reconnectHandlers) handler();
      }
      everConnected = true;
    }
    for (const handler of statusHandlers) handler(next);
  };

  if (enabled && createTransport && workspaceId) {
    socket = createTransport({
      url,
      path: REALTIME_PATH,
      auth: options.auth,
    });

    socket.on("connect", () => {
      lastRev = null;
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
      // Gap detection runs AFTER delivery: this event is real in-order data
      // and must still apply; the gap says something ELSE is missing.
      const rev = (event as { rev?: unknown }).rev;
      if (typeof rev !== "number" || !Number.isInteger(rev) || rev <= 0)
        return;
      if (lastRev === null) {
        lastRev = rev;
        return;
      }
      // Data events ARE the sighting: only a jump proves a loss. A heartbeat
      // carries no data, so ANY advance past the previous sighting means an
      // event in between never arrived (Socket.IO preserves server emit
      // order per socket, so a heartbeat can never overtake its own data).
      const isHeartbeat =
        (event as { type?: unknown }).type === BOARD_REVISION_EVENT_TYPE;
      const gapThreshold = isHeartbeat ? lastRev : lastRev + 1;
      if (rev > gapThreshold) {
        const gap: RevisionGap = { rev, lastSeen: lastRev };
        // Advance BEFORE firing: repeats of this rev (heartbeats re-emit
        // the current value) must not retrigger, and the resync's refetch
        // — not another gap — is what converges the board.
        lastRev = rev;
        for (const handler of gapHandlers) handler(gap);
      } else if (rev > lastRev) {
        lastRev = rev;
      }
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
    onReconnect(handler) {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
    onGap(handler) {
      gapHandlers.add(handler);
      return () => gapHandlers.delete(handler);
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
  /** One bounded resync trigger per true reconnect — see `CollabSocket`. */
  onReconnect: (handler: () => void) => () => void;
  /** One bounded resync trigger per detected revision gap — see `CollabSocket`. */
  onGap: (handler: (gap: RevisionGap) => void) => () => void;
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
  const reconnectHandlersRef = React.useRef(new Set<() => void>());
  const gapHandlersRef = React.useRef(new Set<(gap: RevisionGap) => void>());
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
    const reconnectUnsubscribers = [...reconnectHandlersRef.current].map(
      (handler) => socket.onReconnect(handler),
    );
    const gapUnsubscribers = [...gapHandlersRef.current].map((handler) =>
      socket.onGap(handler),
    );
    const unsubscribeStatus = socket.onStatus(setConnected);

    return () => {
      unsubscribeStatus();
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const unsubscribe of reconnectUnsubscribers) unsubscribe();
      for (const unsubscribe of gapUnsubscribers) unsubscribe();
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

  const onReconnect = React.useCallback((handler: () => void) => {
    reconnectHandlersRef.current.add(handler);
    const unsubscribe = socketRef.current?.onReconnect(handler);
    return () => {
      reconnectHandlersRef.current.delete(handler);
      unsubscribe?.();
    };
  }, []);

  const onGap = React.useCallback((handler: (gap: RevisionGap) => void) => {
    gapHandlersRef.current.add(handler);
    const unsubscribe = socketRef.current?.onGap(handler);
    return () => {
      gapHandlersRef.current.delete(handler);
      unsubscribe?.();
    };
  }, []);

  return { connected, sendEvent, onEvent, onReconnect, onGap };
}
