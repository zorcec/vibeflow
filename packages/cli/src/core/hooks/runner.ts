/**
 * After-hook runner — child process only, never in-process JS (ADR-0006).
 * Pinned by `packages/cli/tests/unit/hooks/runner.test.ts` (see ADR-0006).
 *
 * A hook is `process.execPath` (the running Node — not `node`, which may be
 * absent from PATH) spawned with `shell:false`, `cwd` = project root, and
 * pipes on all three fds. stdin = one envelope JSON + `\n`, then end.
 * stdout is parsed as JSON; stderr passes through prefixed `hook <tool>:`.
 *
 * The module mode (kept from v1): the same envelope goes to
 * stdin of the packaged `hook-loader.mjs`, which dynamic-imports the
 * `<tool>.<phase>.hook.mjs` default export and prints its return value.
 * `console.log/info/warn/debug` is rerouted to stderr child-side in every
 * mode (owner ticket c478fd86): stdio preloads the packaged
 * `hook-console-guard.mjs` via `node --import`, module/module-ts get the
 * same patch at the top of `hook-loader.mjs` — stdout stays reserved for
 * the single JSON document (purity now enforced, not just documented).
 * `module-ts` (`.hook.mts`/`.hook.ts`, kept from v1): the same
 * loader path, type-stripped on import — erasable syntax only, no flags,
 * no transpilation, no tsconfig. A runtime without type stripping refuses
 * LOUDLY (after fail-open `HOOK_TS_UNSUPPORTED`, pre fail-closed
 * `HOOK_BEFORE_TS_UNSUPPORTED`), honoring the phase policy.
 * Mode is chosen by filename extension only (`discover.ts`); every mode
 * shares every bound and the parser below.
 *
 * Bounds (all pinned by `runner.test.ts`):
 * - 2 s deadline PER INVOCATION, covering import + handler + serialization
 *   (module-ts: stripping + import + handler — one budget, same kill).
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
 *
 * Pre-hooks (Stage 2) use the SAME spawn core, deadline, byte limits,
 * env allowlist, and modes — but the opposite failure policy: the gate is
 * fail-CLOSED. Timeout, non-zero exit, non-JSON stdout, bad shape, import
 * error, non-callable default, rejected promise, and unserializable
 * returns all BLOCK the gated write (ticket wla7ci2wzbgaj5dqsrvh1j4o).
 * Success is an explicit `{allow:true}` (optional replacement
 * `instructions`); denial is `{allow:false,reason}`. Anything else refuses
 * with `HOOK_BEFORE_FAILED` — never a silent pass.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HookMode } from "./discover.js";

export const HOOK_INVOCATION_TIMEOUT_MS = 2000;
export const HOOK_MAX_OUTPUT_BYTES = 1024 * 1024;
export const HOOK_GUARD_ENV = "VIBEFLOW_IN_HOOK";

/**
 * TypeScript hook support (Stage 4, ADR-0006): the ACTUAL runtime
 * capability for type stripping — never the `engines.node >= 22` floor,
 * which does not guarantee it. Mirrors `process.features.typescript`:
 * `"strip"` / `"transform"` can import erasable-syntax `.hook.ts` /
 * `.hook.mts` files; anything else (older Node, stripped-down builds)
 * cannot. The probe reads the PARENT runtime, which is sound: the child
 * is always the same `process.execPath` binary, so parent and child
 * capabilities are identical by construction.
 */
export type TypeScriptHookSupport = "strip" | "transform" | "unsupported";

export function resolveTypeScriptHookSupport(): TypeScriptHookSupport {
  const marker = (process.features as { typescript?: unknown } | undefined)
    ?.typescript;
  return marker === "strip" || marker === "transform" ? marker : "unsupported";
}

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
  /** Hook mode (ADR-0006 Stages 1.5+4): stdio executes the file itself,
   *  module/module-ts execute the packaged loader with the file as its
   *  argument (`module-ts` = a `.hook.mts`/`.hook.ts` file, imported with
   *  runtime type stripping). Defaults to `"stdio"` — existing callers
   *  are unaffected. */
  mode?: HookMode;
  /** TypeScript capability override (per-invocation test seam only).
   *  Defaults to the live {@link resolveTypeScriptHookSupport} probe —
   *  production callers never set this; tests use `"unsupported"` to
   *  simulate a runtime without type stripping. */
  typescriptSupport?: TypeScriptHookSupport;
  /** Absolute loader entry override (per-invocation test seam only).
   *  Defaults to the `hook-loader.mjs` shipped next to the executing
   *  bundle — never `process.cwd()`, PATH lookup, or a `--import` shim. */
  loaderEntry?: string;
  /** Absolute console-guard entry override (per-invocation test seam only).
   *  Defaults to the `hook-console-guard.mjs` shipped next to the
   *  executing bundle (same directory as the loader) — never PATH/cwd.
   *  Only used in stdio mode, as the `--import` preload. */
  guardEntry?: string;
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
 * Console-guard location for stdio mode: the `hook-console-guard.mjs`
 * packaged next to the executing CLI bundle (same directory as the
 * loader — `ADR-0006 Stage 1.5` layout), so stdio hooks spawn as
 * `node --import <guard> <hook-file>`. Never `process.cwd()`, PATH
 * lookup, or a source-tree path — same resolution rule as the loader
 * (owner ticket c478fd86).
 */
export function resolveGuardEntry(): string {
  return fileURLToPath(new URL("./hook-console-guard.mjs", import.meta.url));
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
 * Pre-hook decision (Stage 2): explicit allow, or deny with a reason.
 * `instructions`, when present and a string, REPLACES the agent-instruction
 * draft (owner decision: instructions are the only mutable surface).
 */
export type BeforeHookDecision =
  | { allow: true; instructions?: string }
  | { allow: false; reason: string; instructions?: string };

/**
 * Parse hook stdout into a pre-hook decision. `{allow:true}` (explicit
 * boolean) allows; `{allow:false,reason}` denies with a non-empty reason.
 * `instructions`, when present, must be a string or the whole document is
 * malformed. Everything else — empty stdout, non-JSON, non-object, missing
 * or non-boolean `allow`, missing/empty/non-string `reason` on deny,
 * extra keys — is `HOOK_BEFORE_MALFORMED` (fail-closed at the gate).
 */
export function parseBeforeHookOutput(
  stdout: string,
):
  | { ok: true; decision: BeforeHookDecision }
  | { ok: false; reason: string } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { ok: false, reason: "HOOK_BEFORE_MALFORMED" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "HOOK_BEFORE_MALFORMED" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "HOOK_BEFORE_MALFORMED" };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record["allow"] !== "boolean") {
    return { ok: false, reason: "HOOK_BEFORE_MALFORMED" };
  }
  let instructions: string | undefined;
  if (record["instructions"] !== undefined) {
    if (typeof record["instructions"] !== "string") {
      return { ok: false, reason: "HOOK_BEFORE_MALFORMED" };
    }
    instructions = record["instructions"] as string;
  }
  if (record["allow"] === true) {
    const keys = Object.keys(record);
    const extra = keys.filter((k) => k !== "allow" && k !== "instructions");
    if (extra.length > 0) return { ok: false, reason: "HOOK_BEFORE_MALFORMED" };
    return {
      ok: true,
      decision:
        instructions !== undefined && instructions.length > 0
          ? { allow: true, instructions }
          : { allow: true },
    };
  }
  if (typeof record["reason"] !== "string" || record["reason"].length === 0) {
    return { ok: false, reason: "HOOK_BEFORE_MALFORMED" };
  }
  const keys = Object.keys(record);
  const extra = keys.filter(
    (k) => k !== "allow" && k !== "reason" && k !== "instructions",
  );
  if (extra.length > 0) return { ok: false, reason: "HOOK_BEFORE_MALFORMED" };
  return {
    ok: true,
    decision:
      instructions !== undefined && instructions.length > 0
        ? { allow: false, reason: record["reason"] as string, instructions }
        : { allow: false, reason: record["reason"] as string },
  };
}

/** Raw spawn outcome shared by the after (fail-open) and pre (fail-closed) runners. */
type SpawnOutcome =
  | { kind: "reentrant" }
  | { kind: "spawn-failed"; message: string }
  | { kind: "stdin-failed"; message: string }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "output-limit"; maxBytes: number }
  | { kind: "exited"; code: number | null; stdout: string };

/**
 * The ONE child-spawn core (Stage 2 refactor — behavior-identical for
 * after-hooks): mode branch, detached process-group kill, byte limits,
 * stderr passthrough, stdin write. Returns VALUES, never throws; callers
 * apply their phase policy (fail-open vs fail-closed) and print their
 * own one-line verdicts with the historical codes below.
 */
function spawnHookProcess(
  tool: string,
  file: string,
  envelopeJson: string,
  opts: RunAfterHookOptions,
): Promise<SpawnOutcome> {
  const parentEnv = opts.env ?? process.env;
  if (parentEnv[HOOK_GUARD_ENV] === "1") {
    return Promise.resolve({ kind: "reentrant" });
  }
  const timeoutMs = opts.timeoutMs ?? HOOK_INVOCATION_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? HOOK_MAX_OUTPUT_BYTES;

  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (result: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    // ADR-0006 Stages 1.5+4 mode branch: stdio spawns the hook file itself;
    // module AND module-ts spawn the packaged loader with the canonical
    // hook file as its argument (module-ts files are type-stripped on
    // import — erasable syntax only, no flags, no transpilation). Both
    // paths share deadline, byte limits, parser, and stderr-only reporting
    // below — one policy for every mode.
    const mode: HookMode = opts.mode ?? "stdio";
    // stdio preloads the console guard via `--import` (owner ticket
    // c478fd86): `console.log` in a `.mjs` hook lands on stderr, so stdout
    // keeps exactly one JSON document. Module modes get the same patch
    // from the top of `hook-loader.mjs` instead.
    const argv =
      mode === "module" || mode === "module-ts"
        ? [opts.loaderEntry ?? resolveLoaderEntry(), file]
        : ["--import", opts.guardEntry ?? resolveGuardEntry(), file];

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
      settle({
        kind: "spawn-failed",
        message: err instanceof Error ? err.message : "spawn failed",
      });
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
      settle({ kind: "timeout", timeoutMs });
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
      process.stderr.write(`hook ${tool}: ${slice.toString("utf8")}`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({ kind: "spawn-failed", message: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (stdoutTruncated || stdoutChunks > maxBytes) {
        settle({ kind: "output-limit", maxBytes });
        return;
      }
      settle({ kind: "exited", code, stdout });
    });

    try {
      if (child.stdin) {
        child.stdin.write(envelopeJson + "\n");
        child.stdin.end();
      }
    } catch (err) {
      clearTimeout(timer);
      killTree();
      settle({
        kind: "stdin-failed",
        message: err instanceof Error ? err.message : "stdin write failed",
      });
    }
  });
}

/**
 * Run one after-hook file. Failures are VALUES (fail-open), never throws —
 * except for programming errors in OUR code, the write must not fail
 * because a hook did.
 */
/**
 * Run one after-hook file. Failures are VALUES (fail-open), never throws —
 * except for programming errors in OUR code, the write must not fail
 * because a hook did.
 */
/**
 * TypeScript capability gate (Stage 4): a `.hook.ts`/`.hook.mts` hook on a
 * runtime without type stripping is REFUSED, never half-run. After-hooks
 * fail OPEN (the write already happened): one stderr line, no throw.
 * Returns null when the gate passes (no refusal).
 */
function refuseUnsupportedTypeScript(
  tool: string,
  file: string,
  opts: RunAfterHookOptions,
): AfterHookResult | null {
  if ((opts.mode ?? "stdio") !== "module-ts") return null;
  const support = opts.typescriptSupport ?? resolveTypeScriptHookSupport();
  if (support !== "unsupported") return null;
  process.stderr.write(
    `hook ${tool}: HOOK_TS_UNSUPPORTED (${file} needs TypeScript type stripping, unavailable on this runtime ${process.version}) — continuing without hook\n`,
  );
  return { ran: false, reason: "HOOK_TS_UNSUPPORTED" };
}

export async function runAfterHook(
  tool: string,
  file: string,
  envelopeJson: string,
  opts: RunAfterHookOptions,
): Promise<AfterHookResult> {
  const refused = refuseUnsupportedTypeScript(tool, file, opts);
  if (refused !== null) return refused;
  const outcome = await spawnHookProcess(tool, file, envelopeJson, opts);
  switch (outcome.kind) {
    case "reentrant":
      return { ran: false, reason: "HOOK_REENTRANT" };
    case "spawn-failed":
      process.stderr.write(
        `hook ${tool}: HOOK_SPAWN_FAILED (${outcome.message}) — continuing without hook\n`,
      );
      return { ran: false, reason: "HOOK_SPAWN_FAILED" };
    case "stdin-failed":
      process.stderr.write(
        `hook ${tool}: HOOK_STDIN_FAILED (${outcome.message}) — continuing without hook\n`,
      );
      return { ran: false, reason: "HOOK_STDIN_FAILED" };
    case "timeout":
      process.stderr.write(
        `hook ${tool}: HOOK_TIMEOUT (${outcome.timeoutMs}ms per invocation exceeded) — continuing without hook\n`,
      );
      return { ran: false, reason: "HOOK_TIMEOUT" };
    case "output-limit":
      process.stderr.write(
        `hook ${tool}: HOOK_OUTPUT_LIMIT (stdout exceeded ${outcome.maxBytes} bytes) — continuing without hook\n`,
      );
      return { ran: false, reason: "HOOK_OUTPUT_LIMIT" };
    case "exited": {
      if (outcome.code !== 0) {
        process.stderr.write(
          `hook ${tool}: HOOK_NONZERO_EXIT (exit ${outcome.code ?? "signal"}) — continuing without hook\n`,
        );
        return { ran: false, reason: "HOOK_NONZERO_EXIT" };
      }
      const parsed = parseAfterHookOutput(outcome.stdout);
      if (!parsed.ok) {
        process.stderr.write(
          `hook ${tool}: HOOK_BAD_OUTPUT (stdout was not {"instructions":string} or {}) — continuing without hook\n`,
        );
        return { ran: false, reason: parsed.reason };
      }
      return { ran: true, instructions: parsed.instructions };
    }
  }
}

export interface BeforeHookResult {
  ran: boolean;
  allowed: boolean;
  instructions?: string;
  /** Machine-readable failure/deny code for the stderr line + refusal. */
  reason?: string;
  /** The hook's own deny text (only when it returned {allow:false,reason}). */
  hookReason?: string;
}

/**
 * Run one pre-hook file. Failures BLOCK (fail-closed, Stage 2): timeout,
 * non-zero exit, non-JSON stdout, malformed decision, and spawn/stdin
 * failures all return `allowed:false` — the caller refuses the gated
 * write and never retries the hook. An explicit `{allow:false,reason}`
 * returns the hook's own reason. Reentrancy (`VIBEFLOW_IN_HOOK=1`) also
 * blocks: a nested gated write inside a hook must not slip past the gate
 * by recursion. Only an explicit `{allow:true}` allows.
 */
export async function runBeforeHook(
  tool: string,
  file: string,
  envelopeJson: string,
  opts: RunAfterHookOptions,
): Promise<BeforeHookResult> {
  // TypeScript capability gate (Stage 4): pre-hooks fail CLOSED — a gate
  // that cannot even be parsed is not an open gate.
  if ((opts.mode ?? "stdio") === "module-ts") {
    const support = opts.typescriptSupport ?? resolveTypeScriptHookSupport();
    if (support === "unsupported") {
      process.stderr.write(
        `hook ${tool}: HOOK_BEFORE_TS_UNSUPPORTED (${file} needs TypeScript type stripping, unavailable on this runtime ${process.version}) — refusing gated write\n`,
      );
      return { ran: false, allowed: false, reason: "HOOK_BEFORE_TS_UNSUPPORTED" };
    }
  }
  const outcome = await spawnHookProcess(tool, file, envelopeJson, opts);
  switch (outcome.kind) {
    case "reentrant":
      process.stderr.write(
        `hook ${tool}: HOOK_BEFORE_REENTRANT (nested gated write inside a hook) — refusing gated write\n`,
      );
      return { ran: false, allowed: false, reason: "HOOK_BEFORE_REENTRANT" };
    case "spawn-failed":
      process.stderr.write(
        `hook ${tool}: HOOK_BEFORE_SPAWN_FAILED (${outcome.message}) — refusing gated write\n`,
      );
      return { ran: false, allowed: false, reason: "HOOK_BEFORE_SPAWN_FAILED" };
    case "stdin-failed":
      process.stderr.write(
        `hook ${tool}: HOOK_BEFORE_STDIN_FAILED (${outcome.message}) — refusing gated write\n`,
      );
      return { ran: false, allowed: false, reason: "HOOK_BEFORE_STDIN_FAILED" };
    case "timeout":
      process.stderr.write(
        `hook ${tool}: HOOK_BEFORE_TIMEOUT (${outcome.timeoutMs}ms per invocation exceeded) — refusing gated write\n`,
      );
      return { ran: false, allowed: false, reason: "HOOK_BEFORE_TIMEOUT" };
    case "output-limit":
      process.stderr.write(
        `hook ${tool}: HOOK_BEFORE_OUTPUT_LIMIT (stdout exceeded ${outcome.maxBytes} bytes) — refusing gated write\n`,
      );
      return { ran: false, allowed: false, reason: "HOOK_BEFORE_OUTPUT_LIMIT" };
    case "exited": {
      if (outcome.code !== 0) {
        process.stderr.write(
          `hook ${tool}: HOOK_BEFORE_NONZERO_EXIT (exit ${outcome.code ?? "signal"}) — refusing gated write\n`,
        );
        return { ran: false, allowed: false, reason: "HOOK_BEFORE_NONZERO_EXIT" };
      }
      const parsed = parseBeforeHookOutput(outcome.stdout);
      if (!parsed.ok) {
        process.stderr.write(
          `hook ${tool}: HOOK_BEFORE_MALFORMED (stdout was not {"allow":boolean,...}) — refusing gated write\n`,
        );
        return { ran: false, allowed: false, reason: parsed.reason };
      }
      if (!parsed.decision.allow) {
        process.stderr.write(
          `hook ${tool}: HOOK_BEFORE_DENIED (${parsed.decision.reason}) — refusing gated write\n`,
        );
        return {
          ran: true,
          allowed: false,
          reason: "HOOK_BEFORE_DENIED",
          hookReason: parsed.decision.reason,
          ...(parsed.decision.instructions !== undefined
            ? { instructions: parsed.decision.instructions }
            : {}),
        };
      }
      return {
        ran: true,
        allowed: true,
        ...(parsed.decision.instructions !== undefined
          ? { instructions: parsed.decision.instructions }
          : {}),
      };
    }
  }
}
