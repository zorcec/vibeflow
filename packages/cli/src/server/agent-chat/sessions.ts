/**
 * Chat session manager (ticket 0847833f): one long-lived
 * `pi --mode rpc` child process per overlay chat session.
 *
 * WHAT: spawn/kill pi subprocesses with JSONL framing, per-command
 * correlation, idle expiry, and a concurrency cap. The agent runs
 * server-side in `serve` with cwd=projectDir and inherits the user's
 * env/HOME (so MCPs, skills, and auth resolve exactly as in the user's
 * own terminal). The vibeflow-overlay MCP is injected via a
 * project-scoped `.pi/mcp.json` merge — never the global pi settings.
 *
 * WHY a manager instead of ad-hoc spawns: pi honors stdout backpressure
 * and a client that stops reading stalls the process, so exactly one
 * reader per child must run for the child's whole life; sessions also
 * need idle cleanup (an LLM agent process per abandoned chat would leak
 * on a small box — the cap defaults to 2).
 *
 * Framing follows the RPC contract verbatim: split stdout on LF only
 * (Node's readline ALSO splits on U+2028/U+2029, which are valid inside
 * JSON strings), strip one trailing CR, JSON.parse per line. A malformed
 * line is a diagnostic event, never a crash — stderr is diagnostics,
 * never protocol.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isFeatureEnabled, CHAT_FEATURE } from "../../core/feature-flags.js";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const AGENT_CHAT_MCP_SERVER_NAME = "vibeflow-overlay";
export const AGENT_CHAT_MCP_CONFIG_PATH = join(".pi", "mcp.json");

/** pi binary missing at spawn time (degraded chat empty state). */
export const PI_NOT_FOUND = "PI_NOT_FOUND";
/** Too many live sessions (client should close one first). */
export const TOO_MANY_SESSIONS = "TOO_MANY_SESSIONS";
/** A command got no response before the deadline. */
export const COMMAND_TIMEOUT = "COMMAND_TIMEOUT";
/** Write after close / spawn failure. */
export const SESSION_CLOSED = "SESSION_CLOSED";

/** Wire records the RPC child may emit (subset we act on). */
export interface PiWireRecord {
  type: string;
  id?: unknown;
  command?: unknown;
  success?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export type ChatSessionStatus =
  | "starting"
  | "ready"
  | "busy"
  | "closing"
  | "closed"
  | "error";

export interface ChatSessionInfo {
  id: string;
  status: ChatSessionStatus;
  createdAt: number;
  lastActiveAt: number;
  projectDir: string;
}

export interface ChatPromptResult {
  /** The pi command id (correlate responses/events by it when needed). */
  commandId: string;
  /** What pi did with the prompt (`started` | `handled` | ...). */
  disposition: string;
}

export interface ChatSessionEvents {
  /** Any parsed wire record (responses + session events). */
  record: (record: PiWireRecord) => void;
  /** Malformed stdout line (diagnostic — never fatal). */
  parseError: (line: string, error: string) => void;
  /** Process-level stderr output (diagnostics, never protocol). */
  stderr: (text: string) => void;
  /** Child exited or errored. */
  exit: (code: number | null, signal: string | null) => void;
  /** Status transitions. */
  status: (status: ChatSessionStatus) => void;
}

export interface ChatSession {
  readonly id: string;
  readonly projectDir: string;
  status(): ChatSessionStatus;
  info(): ChatSessionInfo;
  on<K extends keyof ChatSessionEvents>(
    event: K,
    listener: ChatSessionEvents[K],
  ): () => void;
  /**
   * Queue a user message (RPC `prompt` command). Resolves when pi
   * ACCEPTS the prompt (disposition), not when the run finishes — the
   * caller keeps consuming `record` events until `agent_settled`.
   */
  prompt(message: string, metadata?: Record<string, unknown>): Promise<ChatPromptResult>;
  /** Interrupt the active run (RPC `abort`). Best-effort when idle. */
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface ChatSessionManagerOptions {
  /** Absolute project root (spawn cwd + `.pi/mcp.json` home). */
  projectDir: string;
  /** Origin of this serve instance (MCP URL = origin + `/api/chat-mcp`). */
  serverOrigin: string;
  /** Max live sessions (default 2 — one pi agent process each). */
  maxSessions?: number;
  /** Close idle sessions after this long (default 30 min, 0 = never). */
  idleTimeoutMs?: number;
  /** Per-command response deadline (default 30 s). */
  commandTimeoutMs?: number;
  /** pi binary (default "pi"; tests inject a stub). */
  piBinary?: string;
  /** Extra env for the child (merged over process.env). */
  extraEnv?: Record<string, string>;
}

interface PendingCommand {
  resolve: (record: PiWireRecord) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
) => ChildProcess;

const DEFAULT_MAX_SESSIONS = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 1000;

export class ChatSessionManager {
  private readonly projectDir: string;
  private readonly serverOrigin: string;
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly piBinary: string;
  private readonly extraEnv: Record<string, string>;
  private readonly spawnFn: SpawnFn;
  private readonly sessions = new Map<string, ManagedChatSession>();
  private commandSeq = 0;

  constructor(opts: ChatSessionManagerOptions, deps?: { spawn?: SpawnFn }) {
    this.projectDir = resolve(opts.projectDir);
    this.serverOrigin = opts.serverOrigin.replace(/\/+$/, "");
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.piBinary = opts.piBinary ?? "pi";
    this.extraEnv = opts.extraEnv ?? {};
    this.spawnFn =
      deps?.spawn ??
      ((cmd, args, spawnOpts) =>
        spawn(cmd, args, {
          cwd: spawnOpts.cwd,
          env: spawnOpts.env,
          stdio: ["pipe", "pipe", "pipe"],
        }));
  }

  /** Live session count (for caps + status endpoints). */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Create a session: merge the overlay MCP entry, spawn pi, start the
   * reader. Throws with code TOO_MANY_SESSIONS at the cap.
   */
  create(): ChatSession {
    if (this.sessions.size >= this.maxSessions) {
      const err = new Error(
        `Too many chat sessions (max ${this.maxSessions}) — close one first`,
      );
      (err as NodeJS.ErrnoException).code = TOO_MANY_SESSIONS;
      throw err;
    }
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    const session = new ManagedChatSession(
      id,
      {
        projectDir: this.projectDir,
        serverOrigin: this.serverOrigin,
        idleTimeoutMs: this.idleTimeoutMs,
        commandTimeoutMs: this.commandTimeoutMs,
        piBinary: this.piBinary,
        extraEnv: this.extraEnv,
        nextCommandId: () => `chat-${id}-${++this.commandSeq}`,
      },
      { spawn: this.spawnFn },
    );
    session.on("exit", () => {
      this.sessions.delete(id);
    });
    this.sessions.set(id, session);
    session.start();
    return session;
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.get(id);
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    await session.close();
    this.sessions.delete(id);
    return true;
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.close().catch(() => {})));
  }
}

/**
 * Ensure `<projectDir>/.pi/mcp.json` routes `vibeflow-overlay` at the
 * serve origin's chat MCP endpoint. Merge-first: existing servers are
 * preserved byte-for-byte apart from our entry (never clobber the
 * user's own MCPs). The per-server `headers` carry the chat session id
 * so the endpoint can scope approvals without touching global pi state.
 */
export function ensureOverlayMcpEntry(
  projectDir: string,
  serverOrigin: string,
  sessionId: string,
): { path: string; created: boolean; updated: boolean } {
  const path = join(resolve(projectDir), AGENT_CHAT_MCP_CONFIG_PATH);
  let doc: Record<string, unknown> = {};
  let existed = false;
  try {
    const raw = readFileSync(path, "utf8");
    existed = true;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unparsable: start fresh (a corrupt mcp.json would break
    // pi's own startup too — ours replaces only when unreadable).
    doc = {};
  }
  const servers =
    doc.servers && typeof doc.servers === "object" && !Array.isArray(doc.servers)
      ? (doc.servers as Record<string, unknown>)
      : {};
  const entry = {
    url: `${serverOrigin.replace(/\/+$/, "")}/api/chat-mcp`,
    headers: { "x-chat-session": sessionId },
  };
  const prev = servers[AGENT_CHAT_MCP_SERVER_NAME];
  const updated =
    !existed ||
    JSON.stringify(prev) !== JSON.stringify(entry);
  servers[AGENT_CHAT_MCP_SERVER_NAME] = entry;
  doc.servers = servers;
  if (updated) {
    mkdirSync(join(resolve(projectDir), ".pi"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }
  return { path, created: !existed, updated };
}

interface ManagedOptions {
  projectDir: string;
  serverOrigin: string;
  idleTimeoutMs: number;
  commandTimeoutMs: number;
  piBinary: string;
  extraEnv: Record<string, string>;
  nextCommandId: () => string;
}

class ManagedChatSession implements ChatSession {
  readonly id: string;
  readonly projectDir: string;
  private readonly opts: ManagedOptions;
  private readonly spawnFn: SpawnFn;
  private readonly listeners: {
    [K in keyof ChatSessionEvents]: Set<ChatSessionEvents[K]>;
  } = {
    record: new Set(),
    parseError: new Set(),
    stderr: new Set(),
    exit: new Set(),
    status: new Set(),
  };
  private child: ChildProcess | null = null;
  private currentStatus: ChatSessionStatus = "starting";
  private createdAt = Date.now();
  private lastActiveAt = Date.now();
  private stdoutBuf = "";
  private pending = new Map<string, PendingCommand>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    id: string,
    opts: ManagedOptions,
    deps: { spawn: SpawnFn },
  ) {
    this.id = id;
    this.projectDir = opts.projectDir;
    this.opts = opts;
    this.spawnFn = deps.spawn;
  }

  status(): ChatSessionStatus {
    return this.currentStatus;
  }

  info(): ChatSessionInfo {
    return {
      id: this.id,
      status: this.currentStatus,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      projectDir: this.projectDir,
    };
  }

  on<K extends keyof ChatSessionEvents>(
    event: K,
    listener: ChatSessionEvents[K],
  ): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  /** Start the child (called once by the manager right after create). */
  start(): void {
    if (this.child || this.closed) return;
    try {
      ensureOverlayMcpEntry(this.projectDir, this.opts.serverOrigin, this.id);
    } catch (err) {
      // A read-only project dir must not kill chat: pi starts without
      // our MCP entry and the website tools simply refuse at call time.
      this.emitStderr(
        `overlay MCP entry unwritable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let child: ChildProcess;
    try {
      child = this.spawnFn(this.opts.piBinary, ["--mode", "rpc"], {
        cwd: this.projectDir,
        env: { ...process.env, ...this.opts.extraEnv } as Record<string, string>,
      });
    } catch (err) {
      this.failStartup(err);
      return;
    }
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer | string) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) =>
      this.emitStderr(chunk.toString()),
    );
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const notFound = new Error(
          "pi binary not found — install pi to use agent chat",
        );
        (notFound as NodeJS.ErrnoException).code = PI_NOT_FOUND;
        this.failStartup(notFound);
        return;
      }
      this.failStartup(err);
    });
    child.on("exit", (code, signal) => {
      this.setStatus("closed");
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        const err = new Error("Chat session ended before the command answered");
        (err as NodeJS.ErrnoException).code = SESSION_CLOSED;
        pending.reject(err);
      }
      this.pending.clear();
      this.clearIdleTimer();
      this.emit("exit", code, signal);
    });
    this.setStatus("ready");
    this.armIdleTimer();
  }

  async prompt(
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<ChatPromptResult> {
    this.touch();
    const record = await this.sendCommand({
      type: "prompt",
      message,
      ...(metadata !== undefined ? { metadata } : {}),
    });
    if (record.success !== true) {
      const err = new Error(
        typeof record.error === "string" && record.error.length > 0
          ? record.error
          : "pi refused the prompt",
      );
      (err as NodeJS.ErrnoException).code = SESSION_CLOSED;
      throw err;
    }
    const data = (record.data ?? {}) as Record<string, unknown>;
    this.setStatus("busy");
    return {
      commandId: typeof record.id === "string" ? record.id : "",
      disposition:
        typeof data.disposition === "string" ? data.disposition : "unknown",
    };
  }

  async abort(): Promise<void> {
    if (!this.child || this.closed) return;
    try {
      await this.sendCommand({ type: "abort" });
    } catch {
      // Best-effort: aborting an idle session has nothing to stop.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.setStatus("closing");
    this.clearIdleTimer();
    const child = this.child;
    this.child = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      const err = new Error("Chat session closed");
      (err as NodeJS.ErrnoException).code = SESSION_CLOSED;
      pending.reject(err);
    }
    this.pending.clear();
    if (!child) {
      this.setStatus("closed");
      return;
    }
    // Orderly RPC shutdown: closing stdin lets pi dispose the runtime.
    // Escalate only if it lingers (a stuck model call must not hang
    // `serve` shutdown or leak the process).
    await new Promise<void>((resolvePromise) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolvePromise();
        }
      };
      child.once("exit", finish);
      try {
        child.stdin?.end();
      } catch {
        finish();
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish();
      }, 5000);
      killTimer.unref();
    });
    this.setStatus("closed");
  }

  private failStartup(err: unknown): void {
    this.setStatus("error");
    this.clearIdleTimer();
    const error =
      err instanceof Error ? err : new Error(String(err));
    this.emitStderr(`chat session failed to start: ${error.message}`);
    this.emit("exit", null, null);
  }

  private sendCommand(
    command: Record<string, unknown> & { type: string },
  ): Promise<PiWireRecord> {
    const child = this.child;
    if (!child || this.closed || !child.stdin || child.stdin.destroyed) {
      const err = new Error("Chat session is not running");
      (err as NodeJS.ErrnoException).code = SESSION_CLOSED;
      return Promise.reject(err);
    }
    const id = this.opts.nextCommandId();
    return new Promise<PiWireRecord>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(
          `Chat command timed out after ${this.opts.commandTimeoutMs}ms`,
        );
        (err as NodeJS.ErrnoException).code = COMMAND_TIMEOUT;
        reject(err);
      }, this.opts.commandTimeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: resolvePromise,
        reject,
        timer,
      });
      const line = `${JSON.stringify({ ...command, id })}\n`;
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed) {
        this.pending.delete(id);
        clearTimeout(timer);
        const gone = new Error("Chat session input closed");
        (gone as NodeJS.ErrnoException).code = SESSION_CLOSED;
        reject(gone);
        return;
      }
      try {
        if (!stdin.write(line)) {
          stdin.once("drain", () => {});
        }
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onStdout(chunk: Buffer | string): void {
    // LF-only framing (never readline): U+2028/U+2029 are legal inside
    // JSON strings and must not split records.
    this.stdoutBuf += chunk.toString("utf8");
    let idx = this.stdoutBuf.indexOf("\n");
    while (idx !== -1) {
      let line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) this.onLine(line);
      idx = this.stdoutBuf.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let record: PiWireRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
      }
      record = parsed as PiWireRecord;
      if (typeof record.type !== "string") {
        throw new Error("missing type");
      }
    } catch (err) {
      this.emit(
        "parseError",
        line,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    this.touch();
    if (
      record.type === "response" &&
      typeof record.id === "string" &&
      this.pending.has(record.id)
    ) {
      const pending = this.pending.get(record.id)!;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      pending.resolve(record);
    }
    this.emit("record", record);
    if (record.type === "agent_settled") {
      if (this.currentStatus === "busy") this.setStatus("ready");
    } else if (record.type === "agent_start" || record.type === "turn_start") {
      if (this.currentStatus === "ready") this.setStatus("busy");
    }
  }

  private touch(): void {
    this.lastActiveAt = Date.now();
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.opts.idleTimeoutMs <= 0 || this.closed) return;
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, this.opts.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private setStatus(status: ChatSessionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.emit("status", status);
  }

  private emitStderr(text: string): void {
    this.emit("stderr", text);
  }

  private emit<K extends keyof ChatSessionEvents>(
    event: K,
    ...args: Parameters<ChatSessionEvents[K]>
  ): void {
    for (const listener of this.listeners[event]) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch {
        // A throwing UI listener must never break the reader loop or
        // the pending-command map — chat degrades, it never wedges.
      }
    }
  }
}

export function isAgentChatEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isFeatureEnabled(CHAT_FEATURE, env);
}
