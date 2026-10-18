"use client";

/**
 * ChatPanel — reusable agent-chat surface (ticket 0847833f).
 *
 * WHAT: a presentational intercom-style panel. It renders messages,
 * streaming tokens, tool-call cards, and approval cards, and collects
 * user input (text + pasted images). It performs NO network and owns NO
 * session: the host (overlay chat container, kanban, web app) drives it
 * through props — same component everywhere, one visual language.
 *
 * WHY props-driven: the overlay talks WS + REST, the kanban page may
 * talk tRPC, the web app something else. Transport differences must not
 * fork the UI. All async state (session id, streaming accumulation,
 * approvals) lives in the host container.
 */

import React from "react";
import { X, Send, Check, Ban, Square, Paperclip, Bot, User, AlertTriangle, ImageIcon } from "lucide-react";

export interface ChatToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  done: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  toolCalls?: ChatToolCall[];
}

export interface ChatApproval {
  approvalId: string;
  toolName: string;
  argsSummary: string;
}

export type ChatPanelStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "busy"
  | "error"
  | "unavailable"
  | "no-pi"
  | "no-auth";

export interface PastedImage {
  id: string;
  file: File;
  previewUrl: string;
}

export interface ChatPanelProps {
  messages: ChatMessage[];
  /** Live-streaming assistant text (appended after the last message). */
  streamingText: string;
  approvals: ChatApproval[];
  status: ChatPanelStatus;
  statusMessage?: string;
  onSend: (message: string, images: File[]) => void;
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
  onAbort: () => void;
  onClose: () => void;
  disabled?: boolean;
}

function argsPreview(args: unknown): string {
  if (args === null || args === undefined) return "{}";
  try {
    const text = JSON.stringify(args);
    return text.length > 220 ? `${text.slice(0, 220)}…` : text;
  } catch {
    return "[unserializable args]";
  }
}

function ToolCard({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div
      data-testid="chat-tool-card"
      data-tool-name={call.toolName}
      data-done={call.done ? "true" : "false"}
      className="vf-chat-tool"
    >
      <button
        type="button"
        className="vf-chat-tool-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="vf-chat-tool-dot" aria-hidden="true" />
        <span className="vf-chat-tool-name">{call.toolName}</span>
        <span className="vf-chat-tool-state">
          {call.done ? (call.isError ? "failed" : "done") : "running…"}
        </span>
      </button>
      {open && (
        <pre className="vf-chat-tool-args">{argsPreview(call.args)}</pre>
      )}
    </div>
  );
}

export function ChatPanel({
  messages,
  streamingText,
  approvals,
  status,
  statusMessage,
  onSend,
  onApprove,
  onDeny,
  onAbort,
  onClose,
  disabled,
}: ChatPanelProps) {
  const [draft, setDraft] = React.useState("");
  const [images, setImages] = React.useState<PastedImage[]>([]);
  const listRef = React.useRef<HTMLDivElement>(null);
  const busy = status === "busy";
  const inputDisabled = disabled === true || status === "connecting";

  React.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, approvals]);

  const imagesRef = React.useRef(images);
  imagesRef.current = images;
  React.useEffect(() => {
    // Revoke any previews still alive at unmount; per-send cleanup
    // revokes eagerly through the same URL API.
    const current = imagesRef.current;
    return () => {
      for (const img of current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  const send = () => {
    const text = draft.trim();
    if (text.length === 0 && images.length === 0) return;
    if (inputDisabled) return;
    onSend(text, images.map((i) => i.file));
    setDraft("");
    for (const img of images) URL.revokeObjectURL(img.previewUrl);
    setImages([]);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files: File[] = [];
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && file.type.startsWith("image/")) files.push(file);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    setImages((prev) => [
      ...prev,
      ...files.map((file, i) => ({
        id: `${Date.now()}-${i}-${file.name}`,
        file,
        previewUrl: URL.createObjectURL(file),
      })),
    ]);
  };

  const degraded =
    status === "unavailable" ||
    status === "no-pi" ||
    status === "no-auth" ||
    status === "error";

  return (
    <div data-testid="chat-panel" className="vf-chat-panel" role="dialog" aria-label="Agent chat">
      <div className="vf-chat-head">
        <Bot size={16} aria-hidden="true" />
        <span className="vf-chat-title">Agent</span>
        {busy && (
          <button
            type="button"
            className="vf-chat-abort"
            onClick={onAbort}
            aria-label="Stop the agent"
            data-testid="chat-abort"
          >
            <Square size={12} aria-hidden="true" /> Stop
          </button>
        )}
        <button
          type="button"
          className="vf-chat-close"
          onClick={onClose}
          aria-label="Close chat"
          data-testid="chat-close"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {degraded && (
        <div className="vf-chat-degraded" data-testid="chat-degraded" data-status={status}>
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {status === "no-pi" &&
              "Chat needs the pi CLI — install pi to talk to the agent."}
            {status === "no-auth" &&
              "Chat needs a signed-in pi provider — run pi auth in your terminal."}
            {status === "unavailable" &&
              "Agent chat is off for this server."}
            {status === "error" && (statusMessage ?? "Chat hit an error — retry below.")}
          </span>
        </div>
      )}

      <div ref={listRef} className="vf-chat-list" data-testid="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`vf-chat-msg vf-chat-msg-${m.role}`}>
            <span className="vf-chat-avatar" aria-hidden="true">
              {m.role === "user" ? <User size={13} /> : <Bot size={13} />}
            </span>
            <div className="vf-chat-bubble">
              {m.text.length > 0 && <p className="vf-chat-text">{m.text}</p>}
              {(m.toolCalls ?? []).map((c) => (
                <ToolCard key={c.toolCallId} call={c} />
              ))}
            </div>
          </div>
        ))}
        {streamingText.length > 0 && (
          <div className="vf-chat-msg vf-chat-msg-assistant">
            <span className="vf-chat-avatar" aria-hidden="true">
              <Bot size={13} />
            </span>
            <div className="vf-chat-bubble">
              <p className="vf-chat-text" data-testid="chat-streaming">
                {streamingText}
                <span className="vf-chat-caret" aria-hidden="true" />
              </p>
            </div>
          </div>
        )}
        {approvals.map((a) => (
          <div
            key={a.approvalId}
            className="vf-chat-approval"
            data-testid="chat-approval"
            data-tool-name={a.toolName}
          >
            <AlertTriangle size={14} aria-hidden="true" />
            <div className="vf-chat-approval-body">
              <div className="vf-chat-approval-title">
                Allow <code>{a.toolName}</code>?
              </div>
              <pre className="vf-chat-approval-args">{a.argsSummary}</pre>
              <div className="vf-chat-approval-actions">
                <button
                  type="button"
                  data-testid="chat-approve"
                  onClick={() => onApprove(a.approvalId)}
                >
                  <Check size={13} aria-hidden="true" /> Approve
                </button>
                <button
                  type="button"
                  data-testid="chat-deny"
                  onClick={() => onDeny(a.approvalId)}
                >
                  <Ban size={13} aria-hidden="true" /> Deny
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {images.length > 0 && (
        <div className="vf-chat-previews" data-testid="chat-previews">
          {images.map((img) => (
            <span key={img.id} className="vf-chat-preview">
              <ImageIcon size={13} aria-hidden="true" />
              <img src={img.previewUrl} alt={img.file.name} />
              <button
                type="button"
                aria-label={`Remove ${img.file.name}`}
                onClick={() =>
                  setImages((prev) => {
                    URL.revokeObjectURL(img.previewUrl);
                    return prev.filter((p) => p.id !== img.id);
                  })
                }
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="vf-chat-input-row">
        <span className="vf-chat-clip" aria-hidden="true" title="Paste images to attach them">
          <Paperclip size={14} />
        </span>
        <textarea
          data-testid="chat-input"
          value={draft}
          disabled={inputDisabled || degraded}
          placeholder={
            degraded ? "Chat unavailable" : "Ask the agent… (paste images to attach)"
          }
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          data-testid="chat-send"
          onClick={send}
          disabled={inputDisabled || degraded || (draft.trim().length === 0 && images.length === 0)}
          aria-label="Send message"
        >
          <Send size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
