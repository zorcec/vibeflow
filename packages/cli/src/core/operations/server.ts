/**
 * Server lifecycle operations (ticket 453c7465, P7 server-lifecycle increment).
 *
 * The shared implementations behind `vibeflow serve [target]` and
 * `vibeflow mcp --project <dir>`. Both are visibly local (registry
 * requirement `local-only` / `none`, no MCP tools): they bind listeners on
 * this machine and start a stdio transport — never the board, never the
 * network beyond localhost. They run through injected ports so unit tests
 * drive fakes instead of binding real listeners or spawning transports;
 * `src/index.ts` keeps flag parsing, root resolution/announcement, and the
 * exit code while every decision about WHAT to start lives here.
 *
 * Contracts (each mirrors the inline branch it replaces, byte-for-byte on
 * every pinned behaviour):
 *
 * startServer — classifies the one coarse mode the CLI reports for
 * telemetry (`api` when no HTML target rides along, `prototype` when one
 * does), then starts exactly one server through the REQUIRED `serve`
 * port (the CLI passes its statically imported `serve()` — which keeps
 * the established `vi.mock(".../server/server.js")` CLI-test seam
 * working; an internal dynamic import would bypass that mock once
 * `src/index.ts` is loaded). The API-only
 * branch serves the operation context's project directory
 * (`ctx.projectDir`, already root-resolved at the CLI boundary); the
 * prototype branch serves the HTML target and lets `serve()` derive the
 * project from it, exactly as the inline branch did. Browser opening
 * (`open`), the Ctrl+C hint, and all startup printing stay inside
 * `serve()` — the renderer performs no server reads of its own and prints
 * nothing on success. A refused bind maps to SERVER_PORT_IN_USE, any
 * other startup failure to SERVER_START_FAILED; the renderer owns the
 * `✗` line and the exit-1 rule.
 *
 * startMcpTransport — resolves the backend mode through the injected
 * `resolveMode` port (default: the real `getMode()`, token presence, never
 * reachability) and starts the stdio transport through the REQUIRED `run`
 * port (the CLI passes its statically imported `runStdioMcp`, same
 * mock-seam reason as `serve`). The transport module keeps
 * owning the JSON-RPC connection and EOF handling; this operation owns
 * only the context setup (which directory, which mode) the plan assigns
 * to the shared layer. The CLI boundary keeps the stderr-only project
 * announcement (stdout is the protocol channel). A transport that fails
 * to connect maps to MCP_TRANSPORT_START_FAILED.
 *
 * What stays out (remainder of P7, named in the ticket comment): routing
 * the `kanban` CLI through the existing `startKanban` operation (it still
 * calls `serve()` directly, including `--dev`/`--no-open` chrome the
 * singleton does not take), the `verify` engine/evidence extraction, and
 * the chat-context classifications.
 */
import type { OperationContext, OperationError } from "../operations.js";
import type { ServeInstance } from "../../server/server.js";
import type { ServeOptions } from "../../core/types.js";
import type { IntegrationGuide } from "../../server/startup-guide.js";
import { getMode } from "../../auth/mode.js";

// ── startServer ──────────────────────────────────────────────────────────

/** What `serve()` needs, minus the module identity (injected for tests). */
export type ServeFn = (
  target: string | undefined,
  options: ServeOptions,
) => Promise<ServeInstance>;

export interface StartServerInput {
  /** HTML file or directory of HTML files; omit for API-only task server. */
  target?: string;
  /** Port number (the CLI's parsed `--port`; NaN passes through and fails). */
  port: number;
  /** Bind hostname (default: localhost; 0.0.0.0 for LAN sharing). */
  host?: string;
  /** Open a browser automatically (the CLI's `--no-open` negation). */
  open?: boolean;
  /** Kanban dev mode: on-disk bundle as a no-store asset + live-reload. */
  dev?: boolean;
  /**
   * Project root for API-only mode. The CLI boundary resolves and
   * announces this before calling; the operation never falls back to
   * `process.cwd()` on its own (prototype mode ignores it — `serve()`
   * derives the project from the target path instead).
   */
  projectDir?: string;
  /**
   * Starts the server. Required (not defaulted): the CLI passes its own
   * statically imported `serve()` so the mock seam stays intact, and unit
   * tests pass fakes that assert the exact args — no real listener ever.
   */
  serve: ServeFn;
}

export interface StartServerData {
  /** Coarse mode the CLI reports for telemetry: target vs no target. */
  mode: "api" | "prototype";
  /** Reachable URL of the started server. */
  url: string;
  /** Localhost twin of `url` when bound to 0.0.0.0, else null. */
  localUrl: string | null;
  /** Integration guide for the started instance (read, not printed). */
  guide: IntegrationGuide;
}

export type StartServerResult =
  | { ok: true; data: StartServerData; steps?: never; error?: never }
  | { ok: false; data?: never; steps?: never; error: OperationError };

/** True for a Node listen() EADDRINUSE failure, on the error or its `cause`. */
function isAddrInUse(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return true;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return (cause as { code?: unknown } | undefined)?.code === "EADDRINUSE";
}

export async function startServer(
  ctx: OperationContext,
  input: StartServerInput,
): Promise<StartServerResult> {
  const run = input.serve;
  const mode = input.target === undefined ? "api" : "prototype";
  try {
    const instance = await run(input.target, {
      port: input.port,
      ...(input.host === undefined ? {} : { host: input.host }),
      // Commander's `--no-open` defaults `open` to true; the operation
      // keeps that default when the caller passes nothing.
      open: input.open ?? true,
      // API-only mode serves the boundary-resolved root; prototype mode
      // lets serve() derive the project from the target path (passing an
      // unrelated cwd-derived dir would mis-resolve the store).
      ...(input.target === undefined
        ? { projectDir: input.projectDir ?? ctx.projectDir }
        : {}),
      ...(input.dev === true ? { dev: true as const } : {}),
    });
    return {
      ok: true,
      data: {
        mode,
        url: instance.url,
        localUrl: instance.localUrl ?? null,
        guide: instance.guide,
      },
    };
  } catch (err) {
    if (isAddrInUse(err)) {
      return {
        ok: false,
        error: {
          code: "SERVER_PORT_IN_USE",
          message: `Port ${input.port} is already in use, so the server could not start.`,
          suggestion:
            "Pass a different --port, or stop whatever is listening on that port.",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "SERVER_START_FAILED",
        message:
          err instanceof Error ? err.message : "Failed to start the server",
        suggestion:
          "Check the target path and port, then run the serve command again.",
      },
    };
  }
}

// ── startMcpTransport ────────────────────────────────────────────────────

/** What stdio startup needs, minus the module identity (injected). */
export type McpRunFn = (
  projectDir: string,
  mode: "local" | "saas",
) => Promise<void>;

async function defaultResolveMode(): Promise<"local" | "saas"> {
  const mode = await getMode();
  return mode === "saas" ? "saas" : "local";
}

export interface StartMcpTransportInput {
  /**
   * Backend mode. When omitted the operation resolves it through
   * `resolveMode` (token presence, never reachability — same fail-closed
   * rule as the inline branch).
   */
  mode?: "local" | "saas";
  /**
   * Resolves the backend mode. Defaults to the real `getMode()` (token
   * presence, never reachability — the same fail-closed rule as the inline
   * branch it replaces); unit tests inject a fake.
   */
  resolveMode?: () => Promise<"local" | "saas">;
  /**
   * Starts the stdio transport. Required (not defaulted): same mock-seam
   * reason as `StartServerInput.serve` — the CLI passes `runStdioMcp`.
   */
  run: McpRunFn;
}

export interface StartMcpTransportData {
  /** The startup-pinned project root the transport serves. */
  projectDir: string;
  /** The backend mode the transport was started with. */
  mode: "local" | "saas";
}

export type StartMcpTransportResult =
  | { ok: true; data: StartMcpTransportData; steps?: never; error?: never }
  | { ok: false; data?: never; steps?: never; error: OperationError };

export async function startMcpTransport(
  ctx: OperationContext,
  input: StartMcpTransportInput,
): Promise<StartMcpTransportResult> {
  const projectDir = ctx.projectDir;
  const mode =
    input.mode ?? (await (input.resolveMode ?? defaultResolveMode)());
  try {
    await input.run(projectDir, mode);
    return { ok: true, data: { projectDir, mode } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "MCP_TRANSPORT_START_FAILED",
        message:
          err instanceof Error
            ? err.message
            : "Failed to start the MCP transport",
        suggestion:
          "Check the project directory is a Vibeflow project, then run the mcp command again.",
      },
    };
  }
}
