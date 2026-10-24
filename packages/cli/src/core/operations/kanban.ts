/**
 * Kanban lifecycle operation (ticket 453c7465, P7 kanban increment).
 *
 * The shared implementation behind `vibeflow kanban` and the `start_kanban`
 * MCP tool. Visibly local (registry requirement `local-only`): it binds a
 * listener on this machine — never the board, never the network beyond the
 * bind host. It runs through injected ports so unit tests drive fakes instead
 * of binding real listeners; `src/index.ts` keeps flag parsing, root
 * resolution/announcement, browser opening (`--no-open`), the changelog
 * chrome and the exit code, while every decision about WHAT to start lives
 * here.
 *
 * Contracts (mirrors the inline `kanban` branch it replaces, byte-for-byte on
 * every pinned behaviour):
 *
 * startKanban — forwards port/host/dev/quiet/noCtrlCHint plus the
 * boundary-resolved project directory (`ctx.projectDir`) to the REQUIRED
 * `start` port (default: the real singleton — which keeps the coalescing
 * semantics exactly where they were, one module-level instance, so a second
 * invocation reuses the first and never starts a second server or
 * renegotiates the live port). The singleton never opens a browser
 * (`open: false` always): the CLI renderer owns the single `open()` call
 * behind `--no-open`, so `--no-open` needs no server option and the operation
 * path is browser-free by construction. The dry-run preview binds nothing
 * and resolves through the same URL rule the real serve() uses, so it names
 * the same URLs the live call will. A refused bind maps to
 * KANBAN_PORT_IN_USE, any other startup failure to KANBAN_START_FAILED; the
 * renderer owns the `✗` line and the exit-1 rule.
 *
 * What stays out: the singleton itself (`server/kanban-server.ts`), the
 * guide builders (`server/startup-guide.ts`), and the renderers. The CLI's
 * only deliberate delta from the inline branch is a failed start: it used to
 * crash with an uncaught serve() rejection, and now refuses cleanly with the
 * operation's code (`✗` + suggestion, exit 1) — the same envelope the
 * `serve` extraction (P7 server-lifecycle increment) already established.
 */
import type {
  OperationContext,
  OperationResult,
  StartKanbanInputType,
} from "../operations.js";
import type {
  GuideUrls,
  IntegrationGuide,
} from "../../server/startup-guide.js";
import type {
  KanbanStartOptions,
  KanbanStartResult,
} from "../../server/kanban-server.js";

/**
 * CLI-only starters the MCP schema does not spell: the kanban dev bundle
 * (`--dev`) and the human renderer's banner switches. The MCP tool never
 * sends them (its surface is unchanged — no `dev`/`quiet` tool input), the
 * `kanban` CLI handler always does. All optional; absent means the
 * singleton's own defaults (production bundle, quiet).
 */
export interface StartKanbanCliOptions {
  /** Kanban dev mode: on-disk bundle as a no-store asset + live-reload. */
  dev?: boolean;
  /**
   * Print serve()'s startup banner. The MCP path omits it (quiet by
   * default — stdout is the JSON-RPC channel); the `kanban` CLI renderer
   * passes false to keep the banner bytes it printed before the extraction.
   */
  quiet?: boolean;
  /**
   * Suppress serve()'s own Ctrl+C hint. The `kanban` CLI renderer passes
   * true — its ready block prints its own Ctrl+C line.
   */
  noCtrlCHint?: boolean;
}

/** The operation input: the MCP tool schema plus the CLI-only starters. */
export type StartKanbanOpInput = StartKanbanInputType &
  StartKanbanCliOptions;

export interface StartKanbanPorts {
  /**
   * Starts (or reuses) the singleton. Defaults to the real
   * `startKanbanServer` (dynamic import: the server pulls in the MCP HTTP
   * transport, which imports the operations registry — a static edge would
   * be a require cycle); unit tests pass fakes that assert the exact
   * options — no real listener ever.
   */
  start?: (
    options: KanbanStartOptions,
  ) => Promise<KanbanStartResult>;
  /** Builds the guide from display URLs. Defaults to the real builder. */
  buildGuide?: (urls: GuideUrls) => IntegrationGuide;
  /** The ONE host→URL rule. Defaults to the real `resolveDisplayUrl`. */
  resolveUrls?: (host: string, port: number) => GuideUrls;
  /** The ANSI-free instruction block. Defaults to the real `guideText`. */
  guideText?: (guide: IntegrationGuide, serverRunning: boolean) => string;
}

/** True for a Node listen() EADDRINUSE failure, on the error or its `cause`. */
function isAddrInUse(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return true;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return (cause as { code?: unknown } | undefined)?.code === "EADDRINUSE";
}

/**
 * Start the kanban board server and return the instruction block the CLI
 * prints (kanban URL, localhost alt URL when bound to 0.0.0.0, agent prompt,
 * integration guide).
 *
 * Idempotent: a second call returns the instance the first started
 * (`alreadyRunning: true`) rather than fighting it for the port — that is what
 * backs the tool's `idempotentHint: true`. The coalescing itself lives in the
 * singleton behind the `start` port, so fakes and the real server agree: the
 * operation maps `started: false` to `alreadyRunning: true` and keeps the
 * FIRST instance's URLs even when the second call names another port.
 *
 * A port already taken by some OTHER process is a clean tool-level refusal
 * (`KANBAN_PORT_IN_USE`), never a raw stack trace.
 */
export async function startKanban(
  ctx: OperationContext,
  input: StartKanbanOpInput,
  ports: StartKanbanPorts = {},
): Promise<OperationResult<unknown>> {
  try {
    // Dynamic imports: the server pulls in the MCP HTTP transport, which
    // imports this module's registry — a static edge would be a require
    // cycle. Each short-circuits when its port is injected, so fakes never
    // pay for (or touch) the real server modules.
    const serverMod =
      ports.start === undefined || ports.guideText === undefined
        ? await import("../../server/kanban-server.js")
        : null;
    const guideMod =
      ports.buildGuide === undefined || ports.resolveUrls === undefined
        ? await import("../../server/startup-guide.js")
        : null;
    const start = ports.start ?? serverMod!.startKanbanServer;
    const DEFAULT_KANBAN_PORT = serverMod?.DEFAULT_KANBAN_PORT ?? 3700;
    const guideText: (
      guide: IntegrationGuide,
      serverRunning: boolean,
    ) => string = ports.guideText ?? serverMod!.guideText;
    const buildIntegrationGuide =
      ports.buildGuide ?? guideMod!.buildIntegrationGuide;
    const resolveDisplayUrl = ports.resolveUrls ?? guideMod!.resolveDisplayUrl;
    const port = input.port ?? DEFAULT_KANBAN_PORT;
    const host = input.host ?? "localhost";

    // Preview: report what WOULD be served and bind nothing. Resolved through
    // the same URL rule the real serve() uses, so the preview names the same
    // URLs the real call will.
    if (input.dryRun) {
      const guide = buildIntegrationGuide(resolveDisplayUrl(host, port));
      return {
        ok: true,
        data: {
          alreadyRunning: false,
          started: false,
          wouldStart: true,
          url: guide.url,
          localUrl: guide.localUrl,
          kanbanUrl: guide.kanbanUrl,
          taskApiUrl: guide.taskApiUrl,
          overlayScriptUrl: guide.overlayScriptUrl,
          injectUrl: guide.injectUrl,
          guide,
          instructions: guideText(guide, false),
        },
        steps: [
          {
            code: "DRY_RUN",
            message: `Kanban server would start on port ${port} (host ${host}); nothing was started`,
          },
        ],
      };
    }

    const { instance, started } = await start({
      projectDir: ctx.projectDir,
      port: input.port,
      host: input.host,
      // Ticket 7e85c338: explicit opt-in only — never default.
      ...(input.dev === true ? { dev: true as const } : {}),
      // The MCP path omits both and inherits the singleton's quiet default
      // (stdout is the JSON-RPC channel); the CLI renderer passes both.
      ...(input.quiet === undefined ? {} : { quiet: input.quiet }),
      ...(input.noCtrlCHint === true ? { noCtrlCHint: true as const } : {}),
    });
    return {
      ok: true,
      data: {
        // `alreadyRunning: true` is the idempotent path — the caller is told
        // it did not just launch a second server.
        alreadyRunning: !started,
        started,
        url: instance.url,
        localUrl: instance.localUrl ?? null,
        kanbanUrl: instance.guide.kanbanUrl,
        taskApiUrl: instance.guide.taskApiUrl,
        overlayScriptUrl: instance.guide.overlayScriptUrl,
        injectUrl: instance.guide.injectUrl,
        guide: instance.guide,
        // ANSI-free: a tool payload must not carry terminal escapes.
        instructions: guideText(instance.guide, true),
      },
    };
  } catch (err) {
    if (isAddrInUse(err)) {
      return {
        ok: false,
        error: {
          code: "KANBAN_PORT_IN_USE",
          message: `Port ${input.port ?? 3700} is already in use, so the kanban server could not start.`,
          suggestion:
            "Pass a different `port`, or stop whatever is listening on that port. If Vibeflow is already running here, call start_kanban again without a port.",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "KANBAN_START_FAILED",
        message:
          err instanceof Error
            ? err.message
            : "Failed to start the kanban server",
        suggestion:
          "Check the port is free and the project directory is a Vibeflow project, then call start_kanban again",
      },
    };
  }
}
