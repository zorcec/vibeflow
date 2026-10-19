/**
 * Overlay chat transport (ticket 0847833f): thin REST + WS glue between
 * the ChatPanel (React, state owner) and the serve chat endpoints.
 *
 * WHAT: session lifecycle, message POST with trusted page metadata +
 * downscaled images, approval POSTs, DOM round-trip responder, and a
 * WS event tap for agent:* frames. No React, no ChatPanel imports —
 * OverlayApp holds all UI state and calls these helpers.
 *
 * TRUST BOUNDARY (the ticket's core rule): the browser POSTs only
 * minimal trusted metadata (url/title/selector+text/parent snippet)
 * plus page images the user explicitly pasted. NEVER the page body —
 * bulk DOM reaches the agent only through the read_dom tool round-trip,
 * which the server wraps as <untrusted-webpage>.
 */
import type { ProtoConfig } from "./core/types.js";
declare const PROTO_CONFIG: ProtoConfig;

export interface ChatPageContext {
  url: string;
  title: string;
  selector?: string;
  selectedText?: string;
  parentSnippet?: string;
}

export interface ChatImagePayload {
  data: string;
  mimeType: string;
}

export interface ChatAgentEvent {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

function apiBase(): string {
  return PROTO_CONFIG.apiUrl.replace(/\/api\/tasks$/, "");
}

async function postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, body: data };
}

/** Create a chat session. Resolves null when the endpoint is absent (old server) or capped. */
export async function createChatSession(): Promise<string | null> {
  try {
    const { status, body } = await postJson<{ sessionId?: string }>("/api/chat/sessions", {});
    if (status !== 200 || typeof body?.sessionId !== "string") return null;
    return body.sessionId;
  } catch {
    return null;
  }
}

/** Send a user message (text + optional images + trusted page context). */
export async function sendChatMessage(
  sessionId: string,
  message: string,
  page: ChatPageContext | undefined,
  images: ChatImagePayload[],
): Promise<{ accepted: boolean; commandId?: string }> {
  try {
    const { status, body } = await postJson<{ accepted?: boolean; commandId?: string }>(
      `/api/chat/${encodeURIComponent(sessionId)}/message`,
      images.length > 0 ? { message, page, images } : { message, page },
    );
    if (status !== 200 || body?.accepted !== true) return { accepted: false };
    return { accepted: true, commandId: body.commandId };
  } catch {
    return { accepted: false };
  }
}

/** Best-effort abort + close (fire-and-forget on unmount). */
export async function closeChatSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${apiBase()}/api/chat/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  } catch {
    // Close is advisory — the server idlescause sessions out anyway.
  }
}

/** Answer an approval card. True when the server recorded the verdict. */
export async function answerApproval(approvalId: string, approved: boolean): Promise<boolean> {
  try {
    const { status } = await postJson(`/api/chat/approvals/${encodeURIComponent(approvalId)}`, {
      approved,
    });
    return status === 200;
  } catch {
    return false;
  }
}

/** Deliver a DOM round-trip answer for a server read_dom request. */
export async function answerToolRequest(
  sessionId: string,
  requestId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await postJson(
      `/api/chat/${encodeURIComponent(sessionId)}/tool-result`,
      { requestId, payload },
    );
  } catch {
    // The server times out unanswered round-trips — no retry needed.
  }
}

/**
 * Collect the trusted page metadata for a message. Minimal by design:
 * URL, title, and — only when the user annotated something — the
 * selector, its text, and the parent snippet. Never the page body.
 */
export function collectPageContext(activeSelector?: string | null): ChatPageContext {
  const ctx: ChatPageContext = {
    url: window.location.href,
    title: document.title,
  };
  if (activeSelector) {
    try {
      const el = document.querySelector(activeSelector);
      if (el instanceof HTMLElement) {
        ctx.selector = activeSelector;
        ctx.selectedText = (el.innerText ?? "").slice(0, 500);
        const parent = el.parentElement;
        ctx.parentSnippet = parent ? (parent.innerText ?? "").slice(0, 500) : undefined;
      }
    } catch {
      // A bad selector degrades to page-only context, never a throw.
    }
  }
  return ctx;
}

/**
 * Extract readable text for a read_dom round-trip (the server wraps it
 * as <untrusted-webpage>). Scoped by selector when given, page text
 * otherwise. Bounded so a hostile page cannot stuff the agent context.
 * Ticket 658d0238: shared maxChars budget (mirrors the server-side
 * READ_PAGE_TEXT_MAX_CHARS in mcp.ts — one budget, two surfaces).
 */
const READ_DOM_MAX_CHARS = 4000;

export interface DomReadResult {
  /** Extracted text (capped at READ_DOM_MAX_CHARS). */
  text: string;
  /** False when a selector was given but matched nothing — the server
   * turns this into a deterministic ELEMENT_NOT_FOUND (ticket 658d0238)
   * instead of an indistinguishable empty string. */
  found: boolean;
}

// NOTE: innerText (not textContent) is deliberate — it returns *rendered*
// text (hidden elements excluded, <br> as newlines), i.e. what the user
// actually sees. textContent would leak hidden/script content to the agent.
// pi-lens-ignore: ast-grep prefer-dom-node-text-content
export function readDomText(selector?: string | null): DomReadResult {
  try {
    if (selector) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement) {
        return { text: (el.innerText ?? "").slice(0, READ_DOM_MAX_CHARS), found: true };
      }
      return { text: "", found: false };
    }
    return { text: (document.body?.innerText ?? "").slice(0, READ_DOM_MAX_CHARS), found: true };
  } catch {
    return { text: "", found: false };
  }
}

/**
 * Downscale pasted images to chat-ready payloads (max 1024px, WebP).
 * Reuses the shared matrix (`transformImageForUpload`) so chat images
 * never drift from task-attachment encoding — then base64s the bytes
 * for the RPC prompt `images` field.
 */
/**
 * Max bytes per pasted image (ticket b8254ee3: 2 MiB). Mirrors the
 * server-side CHAT_IMAGE_MAX_BYTES in agent-chat/mcp.ts — kept as a
 * local const (not an import) so the browser bundle never pulls in
 * Node-only server modules. If the ticket value changes, change both.
 */
export const CHAT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export interface ChatImageResult {
  payloads: ChatImagePayload[];
  /** Names dropped for exceeding the per-file byte cap (user-visible). */
  skipped: string[];
}

export async function imagesToPayloads(files: File[]): Promise<ChatImageResult> {
  const payloads: ChatImagePayload[] = [];
  // Bounded: at most 3 images per message (base64 inflates context),
  // at most CHAT_IMAGE_MAX_BYTES each (ticket 658d0238/b8254ee3).
  // The size gate runs BEFORE the wasm import so an all-oversized batch
  // never pays for codecs — and unit tests never need canvas.
  const skipped: string[] = [];
  const eligible: File[] = [];
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    if (f.size > CHAT_IMAGE_MAX_BYTES) skipped.push(f.name);
    else if (eligible.length < 3) eligible.push(f);
  }
  if (eligible.length === 0) return { payloads, skipped };
  const { transformImageForUpload } = await import("@vibeflow-tools/ui/kanban");
  // Encoding is the shared matrix verbatim — chat never drifts from
  // task-attachment bytes (<=1920 kept byte-identical, wider → 1920 WebP).
  for (const file of eligible) {
    try {
      const transformed = await transformImageForUpload(file, file.name);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.readAsDataURL(transformed.file);
      });
      const match = /^data:(.*?);base64,(.*)$/s.exec(dataUrl);
      const b64 = match?.[2];
      if (!b64) continue;
      payloads.push({ data: b64, mimeType: match?.[1] || "image/webp" });
    } catch {
      // One bad file never blocks the message — it is simply skipped.
    }
  }
  return { payloads, skipped };
}

/** Whether this overlay bundle may show chat at all. */
export function isChatAvailable(): boolean {
  try {
    return PROTO_CONFIG.agentChat === true && PROTO_CONFIG.wsUrl !== "";
  } catch {
    return false;
  }
}

// ── Chat view reducer (pure — unit-tested, no DOM/fetch) ───────────────────
// The React container owns ChatPanel state and folds every WS agent event
// through `applyChatEvent`. Keeping this pure means the merge rules
// (streaming flush, tool-card lifecycle, approval add/remove) are pinned
// without a browser.

import type {
  ChatMessage,
  ChatToolCall,
  ChatApproval,
} from "@vibeflow-tools/ui";

export interface ChatViewState {
  messages: ChatMessage[];
  streamingText: string;
  approvals: ChatApproval[];
}

export function emptyChatView(): ChatViewState {
  return { messages: [], streamingText: "", approvals: [] };
}

let chatMsgSeq = 0;

function nextChatMsgId(): string {
  chatMsgSeq += 1;
  return `chat-m${Date.now().toString(36)}-${chatMsgSeq}`;
}

/**
 * Fold one server WS agent event into view state. Unknown types and
 * foreign sessionIds are ignored (other tabs/sessions share the socket).
 */
export function applyChatEvent(
  state: ChatViewState,
  event: Record<string, unknown>,
  sessionId: string | null,
): ChatViewState {
  const type = event.type;
  if (typeof type !== "string" || !type.startsWith("agent:")) return state;
  // Strict attribution: once the container is bound to a session, only
  // frames carrying that exact session id apply. Session-less frames on
  // a shared socket are unroutable — ignoring them beats leaking one
  // tab's stream into another's panel.
  if (sessionId !== null && event.sessionId !== sessionId) {
    return state;
  }
  switch (type) {
    case "agent:token": {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta) return state;
      return { ...state, streamingText: state.streamingText + delta };
    }
    case "agent:tool-call": {
      const toolCallId =
        typeof event.toolCallId === "string" ? event.toolCallId : null;
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      if (!toolCallId) return state;
      const call: ChatToolCall = {
        toolCallId,
        toolName,
        args: (event.args ?? {}) as unknown,
        done: false,
      };
      return {
        ...state,
        messages: appendToolCall(state.messages, call),
      };
    }
    case "agent:tool-result": {
      const toolCallId =
        typeof event.toolCallId === "string" ? event.toolCallId : null;
      if (!toolCallId) return state;
      return {
        ...state,
        messages: state.messages.map((m) => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map((c) =>
            c.toolCallId === toolCallId
              ? { ...c, done: true, result: event.result, isError: event.isError === true }
              : c,
          ),
        })),
      };
    }
    case "agent:done": {
      if (state.streamingText.length === 0) return { ...state, streamingText: "" };
      // A tool-only turn already opened an empty assistant message for
      // its cards — fill it so one turn stays one message instead of
      // splitting text and cards across two bubbles.
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === "assistant" && last.text === "") {
        return {
          ...state,
          messages: [
            ...state.messages.slice(0, -1),
            { ...last, text: state.streamingText },
          ],
          streamingText: "",
        };
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: nextChatMsgId(), role: "assistant", text: state.streamingText },
        ],
        streamingText: "",
      };
    }
    case "agent:error": {
      const message =
        typeof event.message === "string" ? event.message : "Agent error";
      return {
        ...state,
        messages: [
          ...state.messages,
          ...(state.streamingText.length > 0
            ? [{ id: nextChatMsgId(), role: "assistant" as const, text: state.streamingText }]
            : []),
          { id: nextChatMsgId(), role: "system" as const, text: message },
        ],
        streamingText: "",
      };
    }
    case "agent:approval-request": {
      const approvalId =
        typeof event.approvalId === "string" ? event.approvalId : null;
      if (!approvalId) return state;
      if (state.approvals.some((a) => a.approvalId === approvalId)) return state;
      return {
        ...state,
        approvals: [
          ...state.approvals,
          {
            approvalId,
            toolName:
              typeof event.toolName === "string" ? event.toolName : "tool",
            argsSummary:
              typeof event.argsSummary === "string" ? event.argsSummary : "{}",
          },
        ],
      };
    }
    default:
      return state;
  }
}

/** Remove one approval card (after the user answers it). */
export function resolveChatApproval(
  state: ChatViewState,
  approvalId: string,
): ChatViewState {
  if (!state.approvals.some((a) => a.approvalId === approvalId)) return state;
  return {
    ...state,
    approvals: state.approvals.filter((a) => a.approvalId !== approvalId),
  };
}

function appendToolCall(messages: ChatMessage[], call: ChatToolCall): ChatMessage[] {
  const last = messages[messages.length - 1];
  // Cards attach to the streaming assistant turn when there is one;
  // otherwise they open their own assistant turn (e.g. a tool-only
  // turn with no text yet).
  if (last && last.role === "assistant") {
    return [
      ...messages.slice(0, -1),
      { ...last, toolCalls: [...(last.toolCalls ?? []), call] },
    ];
  }
  return [
    ...messages,
    { id: nextChatMsgId(), role: "assistant", text: "", toolCalls: [call] },
  ];
}
