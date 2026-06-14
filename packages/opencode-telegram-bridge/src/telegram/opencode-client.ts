/**
 * OpenCode HTTP client for the Telegram bot.
 * Standalone — does not import from any external app.
 *
 * Supports both sync and async message flows. Async flow uses SSE
 * for real-time status updates (tool calls, text generation).
 */

const OPENCODE_URL = process.env.OPENCODE_URL || "http://localhost:4096";
const DEBUG = process.env.DEBUG_BRIDGE === "true" || process.env.DEBUG === "true";

// Configure undici global dispatcher with longer headers timeout
// This fixes the UND_ERR_HEADERS_TIMEOUT error for long-running LLM requests
try {
  // Node.js 18+ uses undici internally, access via global symbol
  const undiciGlobal = (globalThis as Record<string, unknown>)[Symbol.for("undici.globalDispatcher.1")] as { defaults?: { headersTimeout?: number } } | undefined;
  if (undiciGlobal?.defaults) {
    undiciGlobal.defaults.headersTimeout = 600_000; // 10 minutes
    if (DEBUG) console.log("[bridge:debug] Set undici headersTimeout to 600s");
  }
} catch {
  // Ignore - undici not accessible
}

function logDebug(msg: string, ...args: unknown[]): void {
  if (DEBUG) console.log(`[bridge:debug] ${msg}`, ...args);
}

function logError(context: string, err: unknown): void {
  const e = err as Error & { cause?: unknown; code?: string };
  console.error(`[bridge] ${context}:`, e.message);
  if (e.code) console.error(`[bridge]   code: ${e.code}`);
  if (e.cause) {
    const cause = e.cause as Error & { code?: string; cause?: unknown };
    console.error(`[bridge]   cause: ${cause.message || cause}`);
    if (cause.code) console.error(`[bridge]   cause.code: ${cause.code}`);
    if (cause.cause) {
      const cause2 = cause.cause as Error;
      console.error(`[bridge]   cause.cause: ${cause2.message || cause2}`);
    }
  }
  if (e.stack && DEBUG) {
    console.error(`[bridge]   stack: ${e.stack.split("\n").slice(1, 4).join("\n   ")}`);
  }
}

async function ocFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${OPENCODE_URL}${path}`;
  const method = init?.method || "GET";
  const start = Date.now();

  logDebug(`ocFetch ${method} ${url}`);

  try {
    const res = await fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(1_800_000),
    });

    const elapsed = Date.now() - start;
    logDebug(`ocFetch ${method} ${url} -> ${res.status} (${elapsed}ms)`);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[bridge] ocFetch ${method} ${url} failed: HTTP ${res.status}, body: ${body.slice(0, 200)}`);
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
  } catch (err) {
    const elapsed = Date.now() - start;
    const e = err as Error & { code?: string; cause?: unknown };

    // Distinguish between abort/timeout and real fetch failures
    if (e.name === "AbortError" || e.name === "TimeoutError") {
      console.error(`[bridge] ocFetch ${method} ${url} ABORTED after ${elapsed}ms: ${e.message}`);
    } else if (e.cause) {
      // Node.js fetch wraps network errors in cause
      const cause = e.cause as Error & { code?: string; syscall?: string };
      console.error(`[bridge] ocFetch ${method} ${url} FETCH FAILED after ${elapsed}ms: ${e.message}`);
      console.error(`[bridge]   cause: ${cause.message || cause}`);
      if (cause.code) console.error(`[bridge]   cause.code: ${cause.code}`);
      if (cause.syscall) console.error(`[bridge]   cause.syscall: ${cause.syscall}`);
    } else {
      console.error(`[bridge] ocFetch ${method} ${url} ERROR after ${elapsed}ms: ${e.message}`);
    }
    throw err;
  }
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
  logDebug(`ocCreateSession: title="${title}"`);
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
  logDebug(`ocSendMessage: session=${sessionId}, model=${model.providerID}/${model.modelID}, text="${text.slice(0, 50)}..."`);
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
  let eventCount = 0;

  if (options?.signal) {
    options.signal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  (async () => {
    try {
      logDebug(`SSE connecting to ${OPENCODE_URL}/global/event (session=${sessionFilter || "all"})`);
      const res = await fetch(`${OPENCODE_URL}/global/event`, {
        signal: ac.signal,
        headers: { Accept: "text/event-stream" },
      });

      if (!res.ok || !res.body) {
        console.error(`[bridge] SSE connection failed: HTTP ${res.status}`);
        throw new Error(`SSE connection failed: ${res.status}`);
      }

      logDebug(`SSE connected (status=${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (active) {
        const { done, value } = await reader.read();
        if (done) {
          logDebug(`SSE stream ended after ${eventCount} events`);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = parseSSEBuffer(buffer);
        buffer = events.remainder;

        for (const event of events.parsed) {
          eventCount++;
          if (sessionFilter && event.sessionID !== sessionFilter) {
            continue;
          }
          if (DEBUG && event.type !== "server.heartbeat") {
            logDebug(`SSE event[${eventCount}]: ${event.type} session=${event.sessionID || "none"}`);
          }
          handler(event);
        }
      }
    } catch (err) {
      const e = err as Error & { code?: string; cause?: unknown };
      if (e.name === "AbortError") {
        logDebug(`SSE aborted after ${eventCount} events`);
      } else {
        console.error(`[bridge] SSE error after ${eventCount} events: ${e.message}`);
        if (e.cause) {
          const cause = e.cause as Error & { code?: string };
          console.error(`[bridge]   cause: ${cause.message || cause}`);
          if (cause.code) console.error(`[bridge]   cause.code: ${cause.code}`);
        }
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
