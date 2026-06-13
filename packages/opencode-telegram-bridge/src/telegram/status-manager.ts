/**
 * StatusManager — real-time progress indicators for Telegram messages.
 *
 * Manages a per-chat status message that updates as OpenCode processes:
 *   "🤔 Thinking..." → "🔧 Running tool-name..." → "📝 Writing..." → final response
 *
 * Uses Telegram's sendChatAction + editMessageText for live feedback.
 * Handles Telegram API rate limits (max 1 edit/sec per message).
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
  /** Interval in ms to send heartbeat progress messages (default: 60000 = 1 min) */
  heartbeatIntervalMs?: number;
}

export type Phase = "thinking" | "tool_running" | "writing";

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
  lastHeartbeatAt: number;
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

function escapeMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, "\\$1");
}

function formatToolStatus(toolId: string, locale: SupportedLocale): string {
  const name = toolName(toolId, locale);
  const escaped = escapeMd(name);
  return `🔧 _${escapeMd(t("running_tool", locale, { tool: "" }).replace("🔧 _", "").replace("..._", ""))}${escaped}\\.\\.\\._`;
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
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 60_000;
  }

  async start(chatId: number, initialText?: string, locale?: SupportedLocale): Promise<string> {
    const statusId = String(chatId);
    this.cancel(statusId);

    const loc = locale ?? "en";
    const text = initialText ?? t("thinking", loc);
    const msg = await this.bot.sendMessage(chatId, text, {
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
      lastHeartbeatAt: now,
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

    status.heartbeatTimer = setInterval(() => {
      if (!status.disposed) {
        this.sendHeartbeat(statusId);
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
    if (status && !status.disposed) {
      const name = toolName(toolId, status.locale);
      status.toolCalls.push(name);
      status.currentTool = name;
      status.phase = "tool_running";
    }
    const status2 = this.pending.get(statusId);
    const locale = status2?.locale ?? "en";
    const name = toolName(toolId, locale);
    const escaped = escapeMd(name);
    const prefix = escapeMd(t("running_tool", locale, { tool: "" }).replace(/🔧\s*_/, "").replace(/\.\.\._$/, ""));
    await this.update(statusId, `🔧 _${prefix}${escaped}\\.\\.\\._`);
  }

  async thinking(statusId: string): Promise<void> {
    const status = this.pending.get(statusId);
    const locale = status?.locale ?? "en";
    if (status && !status.disposed) {
      status.phase = "thinking";
      status.currentTool = null;
    }
    await this.update(statusId, t("thinking", locale));
  }

  async writing(statusId: string): Promise<void> {
    const status = this.pending.get(statusId);
    const locale = status?.locale ?? "en";
    if (status && !status.disposed) {
      status.phase = "writing";
      status.currentTool = null;
    }
    await this.update(statusId, t("writing", locale));
  }

  updateUsage(statusId: string, cost: number, tokens: { input: number; output: number }): void {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return;
    status.cost = cost;
    status.tokensInput = tokens.input;
    status.tokensOutput = tokens.output;
  }

  updateToolSummary(statusId: string, summary: string): void {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return;
    status.currentToolSummary = summary;
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

  complete(statusId: string): void {
    const status = this.pending.get(statusId);
    if (!status) return;
    this.stopTimers(status);
    status.disposed = true;
    this.pending.delete(statusId);
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

  private async sendHeartbeat(statusId: string): Promise<void> {
    const status = this.pending.get(statusId);
    if (!status || status.disposed) return;

    const now = Date.now();
    if (now - status.lastHeartbeatAt < 30_000) return;
    status.lastHeartbeatAt = now;

    const elapsed = now - status.startedAt;
    const elapsedStr = formatElapsed(elapsed);
    const locale = status.locale;

    const lines: string[] = [escapeMd(t("heartbeat_still_working", locale, { elapsed: elapsedStr }))];

    const phaseKey = `phase_${status.phase === "tool_running" ? "running_tool" : status.phase === "writing" ? "generating" : "analyzing"}` as const;
    const phaseLabel = t(phaseKey as "phase_analyzing", locale);

    if (status.phase === "tool_running" && status.currentTool) {
      lines.push(`📍 _${escapeMd(phaseLabel)} — ${escapeMd(status.currentTool)}_`);
    } else {
      lines.push(`📍 _${escapeMd(phaseLabel)}_`);
    }

    if (status.toolCalls.length > 0) {
      const uniqueTools = [...new Set(status.toolCalls)];
      const stepCount = status.toolCalls.length;
      const recent = uniqueTools.slice(-3);
      const chain = recent.join(" → ");
      const extra = uniqueTools.length > 3 ? ` +${uniqueTools.length - 3}` : "";
      lines.push(escapeMd(t("heartbeat_steps", locale, { count: String(stepCount), chain: `${chain}${extra}` })));
    }

    if (status.cost > 0 || status.tokensInput > 0 || status.tokensOutput > 0) {
      const costStr = status.cost > 0 ? `$${status.cost.toFixed(2)}` : "";
      const inStr = status.tokensInput > 0 ? `${formatTokens(status.tokensInput)} in` : "";
      const outStr = status.tokensOutput > 0 ? `${formatTokens(status.tokensOutput)} out` : "";
      const parts = [costStr, inStr && outStr ? `${inStr} / ${outStr}` : inStr || outStr].filter(Boolean);
      if (parts.length > 0) {
        lines.push(escapeMd(t("heartbeat_cost", locale, { cost: parts.join(" · ") })));
      }
    }

    const text = lines.join("\n");
    await this.bot.sendMessage(status.chatId, text, { parse_mode: "MarkdownV2" }).catch(() => {});
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
