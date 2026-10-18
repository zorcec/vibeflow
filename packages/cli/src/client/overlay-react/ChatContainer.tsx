import React from "react";
import { ChatPanel, type ChatMessage } from "@vibeflow-tools/ui";
import type { ProtoConfig } from "../overlay-browser/core/types.js";

declare const PROTO_CONFIG: ProtoConfig;
import { state } from "../overlay-browser/core/state.js";
import {
  createChatSession,
  sendChatMessage,
  closeChatSession,
  answerApproval,
  answerToolRequest,
  collectPageContext,
  readDomText,
  imagesToPayloads,
  isChatAvailable,
  applyChatEvent,
  resolveChatApproval,
  emptyChatView,
} from "../overlay-browser/chat.js";

/**
 * Overlay chat container (ticket 0847833f): owns ChatPanel state and
 * wires it to the serve chat endpoints + WS broadcast.
 *
 * WHAT: session lifecycle (create on open, close on unmount), WS event
 * folding via the pure reducer, message send (trusted page context +
 * downscaled images), approval answers, and the read_dom round-trip
 * responder (server asks → tab reads DOM → POSTs text back).
 *
 * WHY a separate container instead of logic inside OverlayApp: chat is
 * an independent feature slice — OverlayApp stays the trigger/modal
 * shell and mounts this when `isChatAvailable()` (flag + local WS).
 */

let chatMsgSeq = 0;

function userMessage(text: string): ChatMessage {
  chatMsgSeq += 1;
  return { id: `chat-u${Date.now().toString(36)}-${chatMsgSeq}`, role: "user", text };
}

export function ChatContainer({ onClose }: { onClose: () => void }) {
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [view, setView] = React.useState(emptyChatView);
  const [status, setStatus] = React.useState<
    "connecting" | "ready" | "busy" | "error" | "unavailable" | "no-pi" | "no-auth"
  >("connecting");
  const [statusMessage, setStatusMessage] = React.useState<string | undefined>(undefined);
  const sessionRef = React.useRef<string | null>(null);

  // Create the session on mount; close on unmount.
  React.useEffect(() => {
    let cancelled = false;
    if (!isChatAvailable()) {
      setStatus("unavailable");
      return;
    }
    (async () => {
      try {
        // SAFETY: same-origin chat API — base is the server-injected PROTO_CONFIG
        // origin (build-time constant) or window.location.origin; no user input.
        // pi-lens-ignore: ts-ssrf
        const res = await fetch(`${chatBase()}/api/chat/status`);
        if (cancelled) return;
        if (!res.ok) {
          setStatus("unavailable");
          return;
        }
        const body = (await res.json()) as { piAvailable?: boolean };
        if (!body.piAvailable) {
          setStatus("no-pi");
          return;
        }
      } catch {
        if (!cancelled) setStatus("unavailable");
        return;
      }
      const id = await createChatSession();
      if (cancelled) {
        if (id) void closeChatSession(id);
        return;
      }
      if (!id) {
        setStatus("error");
        setStatusMessage("Could not start a chat session — server caps reached or chat disabled.");
        return;
      }
      sessionRef.current = id;
      setSessionId(id);
      setStatus("ready");
    })();
    return () => {
      cancelled = true;
      const id = sessionRef.current;
      sessionRef.current = null;
      if (id) void closeChatSession(id);
    };
  }, []);

  // WS subscription: fold agent frames; answer read_dom round-trips.
  React.useEffect(() => {
    if (!sessionId) return;
    state.onChatEvent = (msg: Record<string, unknown>) => {
      if (msg.type === "agent:tool-request" && msg.sessionId === sessionId) {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
        if (requestId) {
          const selector = typeof msg.selector === "string" ? msg.selector : undefined;
          void answerToolRequest(sessionId, requestId, {
            text: readDomText(selector ?? undefined),
          });
        }
        return;
      }
      if (
        msg.type === "agent:done" ||
        msg.type === "agent:error" ||
        (msg.type === "agent:tool-result" && msg.sessionId === sessionId)
      ) {
        setStatus((prev) => (prev === "busy" ? "ready" : prev));
      }
      setView((prev) => applyChatEvent(prev, msg, sessionId));
    };
    return () => {
      state.onChatEvent = null;
    };
  }, [sessionId]);

  const send = React.useCallback(
    async (message: string, images: File[]) => {
      const id = sessionRef.current;
      if (!id || message.trim().length === 0) {
        if (message.trim().length === 0 && images.length === 0) return;
      }
      if (!id) return;
      setView((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage(message)],
      }));
      setStatus("busy");
      try {
        const payloads = await imagesToPayloads(images);
        const page = collectPageContext();
        const out = await sendChatMessage(id, message, page, payloads);
        if (!out.accepted) {
          setStatus("error");
          setStatusMessage("The agent did not accept the message — retry or reopen chat.");
        }
      } catch {
        setStatus("error");
        setStatusMessage("Message send failed — the server may be unreachable.");
      }
    },
    [],
  );

  const approve = React.useCallback(
    (approvalId: string) => {
      setView((prev) => resolveChatApproval(prev, approvalId));
      void answerApproval(approvalId, true);
    },
    [],
  );

  const deny = React.useCallback(
    (approvalId: string) => {
      setView((prev) => resolveChatApproval(prev, approvalId));
      void answerApproval(approvalId, false);
    },
    [],
  );

  const abort = React.useCallback(() => {
    // Best-effort: the server abort endpoint is session-scoped; the
    // settled event (or a fresh message) returns the panel to ready.
    const id = sessionRef.current;
    if (!id) return;
    void fetch(`${chatBase()}/api/chat/${encodeURIComponent(id)}/abort`, {
      method: "POST",
    }).catch(() => {});
  }, []);

  if (!isChatAvailable()) return null;

  return (
    <div className="vibeflow-chat-dock" data-testid="chat-dock">
      <ChatPanel
        messages={view.messages}
        streamingText={view.streamingText}
        approvals={view.approvals}
        status={status === "ready" || status === "busy" ? status : mapStatus(status)}
        statusMessage={statusMessage}
        onSend={send}
        onApprove={approve}
        onDeny={deny}
        onAbort={abort}
        onClose={onClose}
        disabled={sessionId === null}
      />
    </div>
  );
}

function chatBase(): string {
  // Same origin as the overlay API (apiUrl is .../api/tasks).
  // PROTO_CONFIG is a server-injected build-time constant (see overlay/index.ts).
  try {
    if (typeof PROTO_CONFIG.apiUrl === "string") {
      return new URL(PROTO_CONFIG.apiUrl, window.location.origin).origin;
    }
  } catch {
    // Fall through to same-origin.
  }
  return window.location.origin;
}

function mapStatus(
  s: "connecting" | "ready" | "busy" | "error" | "unavailable" | "no-pi" | "no-auth",
): "connecting" | "ready" | "busy" | "error" | "unavailable" | "no-pi" | "no-auth" {
  return s;
}

/** External bridge: vanilla code opens the chat panel. */
let _externalOpenChat: (() => void) | null = null;

export function showOverlayChat(): void {
  _externalOpenChat?.();
}

export function registerChatOpener(open: () => void): void {
  _externalOpenChat = open;
}
