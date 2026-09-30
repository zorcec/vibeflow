/**
 * The kanban server singleton for the `start_kanban` MCP tool.
 *
 * A module-level instance, because two concurrent tool calls must not fight
 * over a port: the second call returns the FIRST instance (idempotent, matching
 * the tool's `idempotentHint: true`) instead of spawning a rival listener that
 * would fail with EADDRINUSE.
 *
 * STDOUT IS THE PROTOCOL CHANNEL under the MCP stdio transport
 * (`src/mcp/stdio.ts`), so this module NEVER prints. `serve()` is called with
 * `quiet: true`, and the instruction block the human CLI prints is read from
 * `ServeInstance.guide` instead — see `server/startup-guide.ts`, the one place
 * that knows the text.
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
 * second listener. `serve()` is called with `quiet: true` — this module must
 * not write a byte to stdout, and the guide it needs comes back on the
 * instance instead.
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
      // Never open a browser from an agent tool call.
      open: false,
      projectDir: options.projectDir,
      // Stdout is the JSON-RPC channel — print nothing.
      quiet: true,
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
