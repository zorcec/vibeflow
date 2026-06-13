/**
 * OpenCode HTTP client for the Telegram bot.
 * Standalone — does not import from any external app.
 *
 * Supports both sync and async message flows. Async flow uses SSE
 * for real-time status updates (tool calls, text generation).
 */

const OPENCODE_URL = process.env.OPENCODE_URL || "http://localhost:4096";

async function ocFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${OPENCODE_URL}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(1_800_000),
  });
  if (!res.ok) {
    // Sanitize error — don't leak internal server response details
    throw new Error(`OpenCode error ${res.status}`);
  }
  const data = await res.json();
  const errObj =
    data?.error || data?.info?.error || (data?.name?.includes("Error") ? data : null);
  if (errObj) {
    // Sanitize error — extract only safe message, strip internal details
    const msg = errObj?.data?.message || errObj?.message;
    if (typeof msg === "string") {
      // Strip file paths, URLs, stack traces, internal identifiers
      const sanitized = msg
        .replace(/\/[a-zA-Z0-9_/.-]+\.(ts|js|json)/g, "[file]")
        .replace(/https?:\/\/[^\s]+/g, "[url]")
        .replace(/at\s+.*\n?/g, "")
        .slice(0, 200);
      throw new Error(sanitized || "OpenCode error");
    }
    throw new Error("OpenCode error");
  }
  return data;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface OcHealth {
  connected: boolean;
  version?: string;
}

export interface OcSession {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OcMessage {
  info: { id: string; role: string; createdAt?: string };
  parts: Array<{ type: string; text?: string; tool?: string; [k: string]: unknown }>;
}

export interface OcProvider {
  id: string;
  name?: string;
  models?: Array<{ id: string; name?: string }>;
}

// ── Health ───────────────────────────────────────────────────────────────────

export function ocHealth(): Promise<OcHealth> {
  return ocFetch<{ healthy?: boolean; version?: string }>("/global/health")
    .then((data) => ({ connected: !!data.healthy, version: data.version }))
    .catch(() => ({ connected: false }));
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export function ocCreateSession(title: string): Promise<{ id: string; title: string }> {
  return ocFetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export function ocListSessions(): Promise<OcSession[]> {
  return ocFetch<OcSession[]>("/session");
}

export function ocDeleteSession(id: string): Promise<void> {
  return ocFetch(`/session/${id}`, { method: "DELETE" });
}

// ── Messages ─────────────────────────────────────────────────────────────────

export function ocSendMessage(
  sessionId: string,
  model: { providerID: string; modelID: string },
  text: string,
  signal?: AbortSignal,
): Promise<{ parts: Array<{ type: string; text?: string; tool?: string; [k: string]: unknown }> }> {
  return ocFetch(`/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, parts: [{ type: "text", text }] }),
    signal,
  });
}

export function ocGetMessages(sessionId: string): Promise<OcMessage[]> {
  return ocFetch<OcMessage[]>(`/session/${sessionId}/message`);
}

// ── Control ──────────────────────────────────────────────────────────────────

export function ocAbortSession(id: string): Promise<void> {
  return ocFetch(`/session/${id}/abort`, { method: "POST" });
}

// ── Providers ────────────────────────────────────────────────────────────────

export function ocListProviders(): Promise<OcProvider[]> {
  return ocFetch<OcProvider[]>("/provider");
}

// ── SSE Event Stream ─────────────────────────────────────────────────────────

export interface SSEEvent {
  type: string;
  sessionID?: string;
  properties?: Record<string, unknown>;
}

export type SSEEventHandler = (event: SSEEvent) => void;

/**
 * Subscribe to OpenCode SSE event stream at /global/event.
 * Returns an unsubscribe function.
 */
export function ocSubscribeEvents(
  handler: SSEEventHandler,
  options?: { signal?: AbortSignal; sessionID?: string },
): () => void {
  const ac = new AbortController();
  const sessionFilter = options?.sessionID;
  let active = true;

  if (options?.signal) {
    options.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  (async () => {
    try {
      const res = await fetch(`${OPENCODE_URL}/global/event`, {
        signal: ac.signal,
        headers: { Accept: "text/event-stream" },
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connection failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (active) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = parseSSEBuffer(buffer);
        buffer = events.remainder;

        for (const event of events.parsed) {
          if (sessionFilter && event.sessionID !== sessionFilter) {
            continue;
          }
          handler(event);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[bridge] SSE error:", (err as Error).message);
      }
    }
  })();

  return () => {
    active = false;
    ac.abort();
  };
}

// ── SSE Buffer Parser ────────────────────────────────────────────────────────

interface ParsedSSE {
  parsed: SSEEvent[];
  remainder: string;
}

function parseSSEBuffer(buffer: string): ParsedSSE {
  const events: SSEEvent[] = [];
  let remainder = "";
  const lines = buffer.split("\n");

  let eventType = "";
  let dataLines: string[] = [];
  let inEvent = false;

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      inEvent = true;
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
      inEvent = true;
    } else if (line === "" && inEvent) {
      const dataStr = dataLines.join("\n");
      if (dataStr) {
        try {
          const raw = JSON.parse(dataStr) as Record<string, unknown>;
          const data =
            raw.payload && typeof raw.payload === "object"
              ? (raw.payload as Record<string, unknown>)
              : raw;
          events.push({
            type: (data.type as string) || eventType || "message",
            sessionID:
              ((data.properties as Record<string, unknown>)?.sessionID as string) ||
              (data.sessionID as string) ||
              undefined,
            properties: (data.properties as Record<string, unknown>) || undefined,
          });
        } catch {
          events.push({ type: eventType || "message", properties: { raw: dataStr } });
        }
      }
      eventType = "";
      dataLines = [];
      inEvent = false;
    } else if (line === "" && !inEvent) {
      // Extra blank line — skip
    } else {
      remainder = lines.slice(lines.indexOf(line)).join("\n");
      break;
    }
  }

  if (inEvent) {
    remainder = `event:${eventType}\n${dataLines.map((d) => `data:${d}`).join("\n")}`;
  }

  return { parsed: events, remainder };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse "opencode-go/mimo-v2.5" into { providerID: "opencode-go", modelID: "mimo-v2.5" } */
export function parseModel(modelStr: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = modelStr.split("/");
  return { providerID, modelID: rest.join("/") };
}
