/**
 * The kanban server singleton behind the `start_kanban` MCP tool and the
 * `vibeflow kanban` CLI command (ticket 453c7465, P7 kanban increment).
 *
 * A module-level instance, because two concurrent starters must not fight
 * over a port: the second call returns the FIRST instance (idempotent, matching
 * the tool's `idempotentHint: true`) instead of spawning a rival listener that
 * would fail with EADDRINUSE.
 *
 * STDOUT IS THE PROTOCOL CHANNEL under the MCP stdio transport
 * (`src/mcp/stdio.ts`), so this module is quiet BY DEFAULT: `serve()` is
 * called with `quiet: true` unless the caller passes `quiet: false`, and the
 * instruction block the human CLI prints is read from `ServeInstance.guide`
 * instead — see `server/startup-guide.ts`, the one place that knows the text.
 * The only caller that passes `quiet: false` is the `kanban` CLI renderer,
 * which keeps the exact serve-banner bytes it printed before the extraction.
 * The singleton NEVER opens a browser (`open: false` always): the CLI
 * renderer owns the single `open()` call behind `--no-open`, so the
 * operation path is browser-free by construction and `--no-open` needs no
 * server option of its own.
 */
import { serve } from "./server.js";
import type { ServeInstance } from "./server.js";
import { buildGuideText } from "./startup-guide.js";
import type { IntegrationGuide } from "./startup-guide.js";

/** The default the `serve` / `kanban` CLI commands use. */
export const DEFAULT_KANBAN_PORT = 3700;

export interface KanbanStartOptions {
  projectDir: string;
  port?: number;
  host?: string;
  /**
   * Kanban dev mode (ticket 7e85c338): explicit opt-in only, forwarded to
   * `serve()`. Ignored when an instance is already running — a second call
   * reuses the first instance as-is and never rebinds, so `--dev` cannot
   * change the port contract of a live server.
   */
  dev?: boolean;
  /**
   * Print serve()'s startup banner. Defaults to true (MCP-safe: stdout is
   * the JSON-RPC channel, so print nothing). The `kanban` CLI renderer
   * passes false to keep the banner bytes it printed before the P7
   * extraction. Ignored when an instance is already running.
   */
  quiet?: boolean;
  /**
   * Suppress serve()'s own Ctrl+C hint, forwarded to `serve()`. The
   * `kanban` CLI renderer passes true — its ready block prints its own
   * Ctrl+C line. Ignored when an instance is already running.
   */
  noCtrlCHint?: boolean;
}

export interface KanbanStartResult {
  instance: ServeInstance;
  /** false when an instance was already running and this call reused it. */
  started: boolean;
}

/** The live instance, or null. Module-level so the singleton spans calls. */
let current: ServeInstance | null = null;
/** In-flight start, so two concurrent calls share ONE bind attempt. */
let starting: Promise<KanbanStartResult> | null = null;

/** The running instance, or null when nothing has been started yet. */
export function getKanbanInstance(): ServeInstance | null {
  return current;
}

/**
 * Start the kanban server, or return the one already running.
 *
 * Idempotent by construction: `current` short-circuits before any bind, and a
 * concurrent call awaits the SAME in-flight promise rather than opening a
 * second listener. A call that arrives while an instance (or a bind) is in
 * flight ignores EVERY option — port, host, dev, quiet included — and gets
 * the first instance back with `started: false`, so a second invocation can
 * never start a second server or renegotiate the live one's port.
 *
 * A bind failure (EADDRINUSE) rejects with the underlying error, which the
 * operation layer turns into a structured tool refusal.
 */
export async function startKanbanServer(
  options: KanbanStartOptions,
): Promise<KanbanStartResult> {
  if (current) return { instance: current, started: false };
  // Coalesce: a second call while the first is still binding waits for it
  // rather than racing it to EADDRINUSE.
  if (starting) return starting;

  starting = (async () => {
    const instance = await serve(undefined, {
      port: options.port ?? DEFAULT_KANBAN_PORT,
      host: options.host,
      // Never open a browser from the server path — the `kanban` CLI
      // renderer owns the single `open()` call behind `--no-open`.
      open: false,
      projectDir: options.projectDir,
      // Stdout is the JSON-RPC channel — print nothing unless the human
      // CLI renderer asked for its banner bytes back (`quiet: false`).
      quiet: options.quiet ?? true,
      ...(options.noCtrlCHint === true ? { noCtrlCHint: true as const } : {}),
      // Ticket 7e85c338: explicit opt-in only — never default.
      ...(options.dev === true ? { dev: true as const } : {}),
    });
    current = instance;
    return { instance, started: true };
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** The instruction block, ANSI-free, for a guide. `serverRunning: false` adds
 * the explicit "call start_kanban first" signal required when nothing is up. */
export function guideText(
  guide: IntegrationGuide,
  serverRunning: boolean,
): string {
  return buildGuideText(guide, { serverRunning });
}

/** Stop the singleton. Exists so tests (and a future shutdown path) can
 * release the port; not reachable from any MCP tool. */
export async function closeKanbanServer(): Promise<void> {
  const instance = current;
  current = null;
  if (instance) await instance.close();
}
