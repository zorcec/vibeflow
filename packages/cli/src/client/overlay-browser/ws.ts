import type { ProtoConfig } from "./types.js";
declare const PROTO_CONFIG: ProtoConfig;
import { state, RECONNECT_BASE, RECONNECT_MAX, PING_INTERVAL } from "./state.js";

// ── Stable WebSocket with exponential backoff + ping/pong ────────────────────

export function connectWS(): void {
  // SaaS mode: wsUrl is empty — skip WebSocket entirely (tasks are fetched via HTTP).
  if (!PROTO_CONFIG.wsUrl) return;
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  try { state.ws = new WebSocket(PROTO_CONFIG.wsUrl); } catch { scheduleReconnect(); return; }

  state.ws.onopen = () => {
    state.reconnectAttempt = 0;
    if (state.pingInterval) clearInterval(state.pingInterval);
    state.pingInterval = setInterval(() => {
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL);
  };

  state.ws.onmessage = (e: MessageEvent) => {
    let msg: { type: string };
    try { msg = JSON.parse(e.data as string); } catch { return; }
    if (msg.type === "pong") return;
    if (msg.type === "reload") location.reload();
    if (msg.type === "tasks-updated") state.onTasksUpdatedMessage?.();
    if (msg.type === "task-changed" || msg.type === "task-deleted") state.onTasksUpdatedMessage?.();
  };

  state.ws.onclose = () => {
    if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
    scheduleReconnect();
  };

  state.ws.onerror = () => { state.ws?.close(); };
}

function scheduleReconnect(): void {
  const delay = Math.min(RECONNECT_BASE * Math.pow(2, state.reconnectAttempt), RECONNECT_MAX);
  state.reconnectAttempt++;
  state.reconnectTimer = setTimeout(connectWS, delay);
}

export function setupWsVisibilityReconnect(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (!state.ws || state.ws.readyState !== WebSocket.OPEN)) {
      state.reconnectAttempt = 0;
      connectWS();
    }
  });
}
