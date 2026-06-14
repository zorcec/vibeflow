/**
 * StatusManager — real-time progress indicators for Telegram messages.
 *
 * Manages a per-chat status message that updates live as OpenCode processes:
 *   Phase + current tool + elapsed time + step count + cost — all in one line.
 *
 * Every state change (thinking → tool call → writing) immediately edits the
 * existing message. Heartbeat timer refreshes elapsed time periodically.
 * Never creates new messages for status — always edits the last one.
 *
 * Supports i18n: all status strings are translated to the user's detected language.
 */

import type TelegramBot from "node-telegram-bot-api";
import type { SupportedLocale } from "../i18n/index.js";
import { t, toolName } from "../i18n/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StatusManagerOptions {
  /** Interval in ms to cycle sendChatAction (default: 4000) */
  chatActionInterval?: number;
  /** Minimum interval in ms between message edits (Telegram limit: 1000) */
  editThrottleMs?: number;
  /** Interval in ms to refresh elapsed time in status message (default: 5000) */
  heartbeatIntervalMs?: number;
}

export type Phase = "thinking" | "tool_running" | "writing" | "coding" | "searching" | "responding";

// Tool classification for granular status
const CODING_TOOLS = new Set(["write", "edit", "create", "mkdir", "rename"]);
const SEARCH_TOOLS = new Set(["glob", "grep", "find", "read", "list_directory"]);

// Phase → i18n key for phase label
const PHASE_I18N: Record<Phase, string> = {
  thinking: "phase_analyzing",
  tool_running: "phase_running_tool",
  coding: "phase_coding",
  searching: "phase_searching",
  writing: "phase_responding",
  responding: "phase_responding",
};

interface PendingStatus {
  chatId: number;
  messageId: number;
  chatActionTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lastEditTime: number;
  currentText: string;
  disposed: boolean;
  startedAt: number;
  phase: Phase;
  currentTool: string | null;
  toolCalls: string[];
  cost: number;
  tokensInput: number;
  tokensOutput: number;
  currentToolSummary: string | null;
  locale: SupportedLocale;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function escapeMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+=|{}.!\\\-])/g, "\\$1");
}

// ── StatusManager class ──────────────────────────────────────────────────────

export class StatusManager {
  private bot: TelegramBot;
  private pending = new Map<string, PendingStatus>();
  private chatActionInterval: number;
  private editThrottleMs: number;
  private heartbeatIntervalMs: number;

  constructor(bot: TelegramBot, options?: StatusManagerOptions) {
    this.bot = bot;
    this.chatActionInterval = options?.chatActionInterval ?? 4000;
    this.editThrottleMs = options?.editThrottleMs ?? 1200;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 5000;
  }

  async start(chatId: number, initialText?: string, locale?: SupportedLocale): Promise<string> {
    const statusId = String(chatId);
    this.cancel(statusId);

    const loc = locale ?? "en";
    const text = initialText ?? t("thinking", loc);
    const msg = await this.bot.sendMessage(chatId, escapeMd(text), {
      parse_mode: "MarkdownV2",
    });

    const now = Date.now();
    const status: PendingStatus = {
      chatId,
      messageId: msg.message_id,
      chatActionTimer: null,
      heartbeatTimer: null,
      lastEditTime: 0,
      currentText: text,
      disposed: false,
      startedAt: now,
      phase: "thinking",
      currentTool: null,
      toolCalls: [],
      cost: 0,
      tokensInput: 0,
      tokensOutput: 0,
      currentToolSummary: null,
      locale: loc,
    };

    status.chatActionTimer = setInterval(() => {
      if (!status.disposed) {
        this.bot.sendChatAction(chatId, "typing").catch(() => {});
      }
    }, this.chatActionInterval);

    // Heartbeat: refresh elapsed time in status message
    status.heartbeatTimer = setInterval(() => {
      if (!status.disposed) {
        this.refreshStatus(statusId);
      }
    }, this.heartbeatIntervalMs);

    this.bot.sendChatAction(chatId, "typing").catch(() => {});
    this.pending.set(statusId, status);
    return statusId;
  }

  async update(statusId: string, text: string): Promise<void> {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return;
    if (text === status.currentText) return;

    const now = Date.now();
    const timeSinceLastEdit = now - status.lastEditTime;

    if (timeSinceLastEdit < this.editThrottleMs) {
      const delay = this.editThrottleMs - timeSinceLastEdit;
      setTimeout(() => this.doEdit(status, text), delay);
      return;
    }

    this.doEdit(status, text);
  }

  async toolStart(statusId: string, toolId: string): Promise<void> {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return;

    const name = toolName(toolId, status.locale);
    status.toolCalls.push(name);
    status.currentTool = name;
    status.phase = CODING_TOOLS.has(toolId) ? "coding" : SEARCH_TOOLS.has(toolId) ? "searching" : "tool_running";

    await this.refreshStatus(statusId);
  }

  async thinking(statusId: string): Promise<void> {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return;

    status.phase = "thinking";
    status.currentTool = null;

    await this.refreshStatus(statusId);
  }

  async writing(statusId: string): Promise<void> {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return;

    status.phase = "responding";
    status.currentTool = null;

    await this.refreshStatus(statusId);
  }

  updateUsage(statusId: string, cost: number, tokens: { input: number; output: number }): void {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return;
    status.cost = cost;
    status.tokensInput = tokens.input;
    status.tokensOutput = tokens.output;
    // Don't refresh on every usage update — heartbeat will pick it up
  }

  updateToolSummary(statusId: string, summary: string): void {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return;
    status.currentToolSummary = summary;
    // Refresh to show the tool summary
    this.refreshStatus(statusId);
  }

  getMessageId(statusId: string): number | null {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return null;
    return status.messageId;
  }

  getChatId(statusId: string): number | null {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return null;
    return status.chatId;
  }

  complete(statusId: string): { elapsed: string; toolCalls: string[]; cost: number; tokensInput: number; tokensOutput: number } | null {
    const status = this.pending.get(statusId);
    if (!status) return null;
    this.stopTimers(status);

    // Collect stats for the handler to use (don't edit message here - handler will do it)
    const elapsed = Date.now() - status.startedAt;
    const elapsedStr = formatElapsed(elapsed);
    const toolCalls = [...status.toolCalls];
    const cost = status.cost;
    const tokensInput = status.tokensInput;
    const tokensOutput = status.tokensOutput;

    status.disposed = true;
    this.pending.delete(statusId);

    return { elapsed: elapsedStr, toolCalls, cost, tokensInput, tokensOutput };
  }

  async cancel(statusId: string): Promise<void> {
    const status = this.pending.get(statusId);
    if (!status) return;
    this.stopTimers(status);
    status.disposed = true;
    await this.bot.deleteMessage(status.chatId, status.messageId).catch(() => {});
    this.pending.delete(statusId);
  }

  async shutdown(): Promise<void> {
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    await Promise.allSettled(
      entries.map(async ([, status]) => {
        this.stopTimers(status);
        status.disposed = true;
        await this.bot.deleteMessage(status.chatId, status.messageId).catch(() => {});
      }),
    );
  }

  // ── Private: build live status text ───────────────────────────────────────

  /**
   * Build the full status text from current state.
   * Shows: phase icon + label, current tool (if any), elapsed time, steps, cost.
   */
  private buildStatusText(status: PendingStatus): string {
    const locale = status.locale;
    const elapsed = Date.now() - status.startedAt;
    const elapsedStr = formatElapsed(elapsed);

    // Phase icon + label
    const PHASE_ICONS: Record<Phase, string> = {
      thinking: "🤔",
      tool_running: "🔧",
      coding: "💻",
      searching: "🔍",
      writing: "📝",
      responding: "💬",
    };
    const icon = PHASE_ICONS[status.phase];
    const phaseKey = PHASE_I18N[status.phase];
    const phaseLabel = t(phaseKey as "phase_analyzing", locale);

    // Build line 1: icon + phase + current tool
    let line1: string;
    if (status.currentTool) {
      line1 = `${icon} _${escapeMd(phaseLabel)} \\— ${escapeMd(status.currentTool)}_`;
    } else {
      line1 = `${icon} _${escapeMd(phaseLabel)}\\.\\.\\._`;
    }

    // Build line 2: elapsed + step count
    // Show elapsed time after 1 second to avoid "0s" flash, but show step count immediately
    const lines: string[] = [line1];
    const parts: string[] = [];
    
    // Only show elapsed time after 1 second to avoid "0s" flash
    if (elapsed > 1000) {
      parts.push(`⏱️ ${escapeMd(elapsedStr)}`);
    }
    
    // Show step count immediately when there are tool calls
    if (status.toolCalls.length > 0) {
      const stepCount = status.toolCalls.length;
      const uniqueTools = [...new Set(status.toolCalls)];
      const chain = uniqueTools.slice(-3).join(" \\→ ");
      const extra = uniqueTools.length > 3 ? ` \\+${uniqueTools.length - 3}` : "";
      parts.push(`Step ${stepCount}\\: ${escapeMd(chain)}${extra}`);
    }
    
    if (parts.length > 0) {
      lines.push(parts.join(" \\| "));
    }

    // Build line 3: cost (if any)
    if (status.cost > 0 || status.tokensInput > 0 || status.tokensOutput > 0) {
      const costStr = status.cost > 0 ? `\\$${status.cost.toFixed(2)}` : "";
      const inStr = status.tokensInput > 0 ? `${formatTokens(status.tokensInput)} in` : "";
      const outStr = status.tokensOutput > 0 ? `${formatTokens(status.tokensOutput)} out` : "";
      const costParts = [costStr, inStr && outStr ? `${inStr} / ${outStr}` : inStr || outStr].filter(Boolean);
      if (costParts.length > 0) {
        lines.push(`💰 ${escapeMd(costParts.join(" · "))}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Rebuild and edit the status message with current state.
   * Called on every phase change, tool start, and heartbeat tick.
   */
  private async refreshStatus(statusId: string): Promise<void> {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return;

    const text = this.buildStatusText(status);
    await this.update(statusId, text);
  }

  private doEdit(status: PendingStatus, text: string): void {
    if (status.disposed) return;
    status.lastEditTime = Date.now();
    status.currentText = text;
    this.bot
      .editMessageText(text, {
        chat_id: status.chatId,
        message_id: status.messageId,
        parse_mode: "MarkdownV2",
      })
      .catch(() => {});
  }

  private stopTimers(status: PendingStatus): void {
    if (status.chatActionTimer) {
      clearInterval(status.chatActionTimer);
      status.chatActionTimer = null;
    }
    if (status.heartbeatTimer) {
      clearInterval(status.heartbeatTimer);
      status.heartbeatTimer = null;
    }
  }
}
