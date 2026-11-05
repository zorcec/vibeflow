/**
 * After-hook runner — child process only, never in-process JS (ADR-0006).
 * Pinned by `packages/cli/tests/unit/hooks/runner.test.ts` (see ADR-0006).
 *
 * A hook is `process.execPath` (the running Node — not `node`, which may be
 * absent from PATH) spawned with `shell:false`, `cwd` = project root, and
 * pipes on all three fds. stdin = one envelope JSON + `\n`, then end.
 * stdout is parsed as JSON; stderr passes through prefixed `hook <event>:`.
 *
 * Stage 1.5 adds the module mode (ADR-0006): the same envelope goes to
 * stdin of the packaged `hook-loader.mjs`, which dynamic-imports the
 * `after-<event>.hook.mjs` default export and prints its return value.
 * Mode is chosen by filename extension only (`discover.ts`); both modes
 * share every bound and the parser below.
 *
 * Bounds (all pinned by `runner.test.ts`):
 * - 2 s deadline PER INVOCATION, covering import + handler + serialization.
 *   Expiry SIGKILLs the child AND its process tree (detached group kill),
 *   so a parent that holds inherited pipes open still settles in time.
 * - After-hooks fail OPEN (the write already happened): timeout, non-zero
 *   exit, non-JSON stdout, or a bad shape drops the hook with one stderr
 *   line — never a throw, never a blocked write.
 * - Stdout/stderr BYTE LIMITS (1 MiB each): a hook that floods output is
 *   truncated and treated as a failure, not buffered into OOM.
 * - Child env allowlist: PATH + HOME + VIBEFLOW_IN_HOOK only — never the
 *   API token (`auth/token.ts`, `auth/project-auth`).
 * - Reentrancy guard: the child runs with `VIBEFLOW_IN_HOOK=1`; when that
 *   var is already set the runner returns `{ran:false}` WITHOUT spawning,
 *   so a hook shelling out to `vibeflow tasks --edit` cannot recurse. The
 *   guard disables nested HOOKS, not nested writes — the inner command
 *   still runs, it just emits no further hooks (wording matters: this is a
 *   cycle breaker, not a write lock).
 * - The runner NEVER writes to `process.stdout` — hook chatter is stderr
 *   only, so `--json` stays byte-clean for piping.
 *
 * Complete result schemas: an after-hook succeeds with
 * `{instructions:"..."}` or the no-op `{}`; `undefined`, malformed JSON,
 * unserializable values, and wrong-typed `instructions` are all REJECTED
 * (fail-open with `HOOK_BAD_OUTPUT`), never coerced.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HookMode } from "./discover.js";

export const HOOK_INVOCATION_TIMEOUT_MS = 2000;
export const HOOK_MAX_OUTPUT_BYTES = 1024 * 1024;
export const HOOK_GUARD_ENV = "VIBEFLOW_IN_HOOK";

export interface AfterHookResult {
  ran: boolean;
  instructions?: string;
  /** Machine-readable failure code for the stderr line (when !ran or dropped). */
  reason?: string;
}

export interface RunAfterHookOptions {
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  PATH?: string;
  HOME?: string;
  /** Hook mode (ADR-0006 Stage 1.5): stdio executes the file itself,
   *  module executes the packaged loader with the file as its argument.
   *  Defaults to `"stdio"` — existing callers are unaffected. */
  mode?: HookMode;
  /** Absolute loader entry override (per-invocation test seam only).
   *  Defaults to the `hook-loader.mjs` shipped next to the executing
   *  bundle — never `process.cwd()`, PATH lookup, or a `--import` shim. */
  loaderEntry?: string;
}

/**
 * Loader location for module mode: the `hook-loader.mjs` packaged next to
 * the executing CLI bundle (ADR-0006 Stage 1.5). `import.meta.url` is the
 * bundle's own location in both layouts (`dist/index.js` and
 * `dist/cli/index.js`) and the `src/` tree under test — never a
 * source-tree absolute path or a nonexistent `--import` specifier.
 */
export function resolveLoaderEntry(): string {
  return fileURLToPath(new URL("./hook-loader.mjs", import.meta.url));
}

/**
 * Parse hook stdout into an instructions string. Returns `{ok:true}` with
 * the instructions (or undefined for the `{}` no-op), or `{ok:false}` with
 * the failure code. `undefined`/malformed/unserializable/wrong-typed all
 * fail — the caller reports them as HOOK_BAD_OUTPUT, fail-open.
 */
export function parseAfterHookOutput(
  stdout: string,
): { ok: true; instructions?: string } | { ok: false; reason: string } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { ok: false, reason: "HOOK_BAD_OUTPUT" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "HOOK_BAD_OUTPUT" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "HOOK_BAD_OUTPUT" };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return { ok: true };
  if (keys.length === 1 && keys[0] === "instructions") {
    if (typeof record["instructions"] !== "string") {
      return { ok: false, reason: "HOOK_BAD_OUTPUT" };
    }
    // JSON.parse already guarantees serializable; an empty string is a no-op.
    if ((record["instructions"] as string).length === 0) return { ok: true };
    return { ok: true, instructions: record["instructions"] as string };
  }
  return { ok: false, reason: "HOOK_BAD_OUTPUT" };
}

function childEnv(opts: RunAfterHookOptions, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: opts.PATH ?? parent.PATH ?? "",
    HOME: opts.HOME ?? parent.HOME ?? "",
    [HOOK_GUARD_ENV]: "1",
  };
}

/**
 * Run one after-hook file. Failures are VALUES (fail-open), never throws —
 * except for programming errors in OUR code, the write must not fail
 * because a hook did.
 */
export async function runAfterHook(
  event: string,
  file: string,
  envelopeJson: string,
  opts: RunAfterHookOptions,
): Promise<AfterHookResult> {
  const parentEnv = opts.env ?? process.env;
  if (parentEnv[HOOK_GUARD_ENV] === "1") {
    return { ran: false, reason: "HOOK_REENTRANT" };
  }
  const timeoutMs = opts.timeoutMs ?? HOOK_INVOCATION_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? HOOK_MAX_OUTPUT_BYTES;

  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (result: AfterHookResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    // ADR-0006 Stage 1.5 mode branch: stdio spawns the hook file itself;
    // module spawns the packaged loader with the canonical hook file as
    // its argument. Both paths share deadline, byte limits, parser, and
    // stderr-only reporting below — one policy for both modes.
    const mode: HookMode = opts.mode ?? "stdio";
    const argv =
      mode === "module"
        ? [opts.loaderEntry ?? resolveLoaderEntry(), file]
        : [file];

    let child;
    try {
      child = spawn(process.execPath, argv, {
        cwd: opts.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv(opts, parentEnv),
        // Own process group: on timeout the WHOLE tree dies, so inherited
        // pipes held open by grandchildren cannot outlive the deadline.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      process.stderr.write(
        `hook ${event}: HOOK_SPAWN_FAILED (${err instanceof Error ? err.message : "spawn failed"}) — continuing without hook\n`,
      );
      settle({ ran: false, reason: "HOOK_SPAWN_FAILED" });
      return;
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stdout = "";
    let stdoutChunks = 0;

    const killTree = (): void => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        // Negative pid = the whole detached group (grandchildren included).
        if (child.pid !== undefined && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      killTree();
      process.stderr.write(
        `hook ${event}: HOOK_TIMEOUT (${timeoutMs}ms per invocation exceeded) — continuing without hook\n`,
      );
      settle({ ran: false, reason: "HOOK_TIMEOUT" });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks += chunk.length;
      if (stdoutBytes + chunk.length > maxBytes) {
        stdoutTruncated = true;
        return;
      }
      stdoutBytes += chunk.length;
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxBytes) return;
      const slice = chunk.subarray(0, maxBytes - stderrBytes);
      stderrBytes += slice.length;
      process.stderr.write(`hook ${event}: ${slice.toString("utf8")}`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      process.stderr.write(
        `hook ${event}: HOOK_SPAWN_FAILED (${err.message}) — continuing without hook\n`,
      );
      settle({ ran: false, reason: "HOOK_SPAWN_FAILED" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (stdoutTruncated || stdoutChunks > maxBytes) {
        process.stderr.write(
          `hook ${event}: HOOK_OUTPUT_LIMIT (stdout exceeded ${maxBytes} bytes) — continuing without hook\n`,
        );
        settle({ ran: false, reason: "HOOK_OUTPUT_LIMIT" });
        return;
      }
      if (code !== 0) {
        process.stderr.write(
          `hook ${event}: HOOK_NONZERO_EXIT (exit ${code ?? "signal"}) — continuing without hook\n`,
        );
        settle({ ran: false, reason: "HOOK_NONZERO_EXIT" });
        return;
      }
      const parsed = parseAfterHookOutput(stdout);
      if (!parsed.ok) {
        process.stderr.write(
          `hook ${event}: HOOK_BAD_OUTPUT (stdout was not {\"instructions\":string} or {}) — continuing without hook\n`,
        );
        settle({ ran: false, reason: parsed.reason });
        return;
      }
      settle({ ran: true, instructions: parsed.instructions });
    });

    try {
      if (child.stdin) {
        child.stdin.write(envelopeJson + "\n");
        child.stdin.end();
      }
    } catch (err) {
      clearTimeout(timer);
      killTree();
      process.stderr.write(
        `hook ${event}: HOOK_STDIN_FAILED (${err instanceof Error ? err.message : "stdin write failed"}) — continuing without hook\n`,
      );
      settle({ ran: false, reason: "HOOK_STDIN_FAILED" });
    }
  });
}
