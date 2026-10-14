/**
 * Shared `serve()` boot with bounded EADDRINUSE retry.
 *
 * Background: `getFreePort()` (tests/ports.ts) probes the OS for a free port
 * and releases it, so under the unit-suite thread pool (or a concurrent suite
 * run) another worker can claim the port before `serve()` binds it — `serve()`
 * needs a pre-known port because its URLs are derived from it before listen.
 * Every server-booting test therefore retries a fresh port on EADDRINUSE.
 * This module is the ONE place that logic lives; test files must not
 * hand-roll their own retry loops.
 *
 * Contract:
 * - Owns the port: picks a fresh free port per attempt and never reuses a
 *   port already handed out in this process (module-level Set).
 * - Retries EADDRINUSE only, up to `maxAttempts` (default 8). A failed
 *   `serve()` call yields no instance (the promise rejects), so there is no
 *   partial instance for the helper to close — cleanup of a refused boot
 *   (watchers, wss) is owned by `serve()` itself, which closes everything
 *   it created before rejecting.
 * - Between attempts it yields the event loop with a small jittered backoff
 *   so a thundering herd of simultaneously booting workers decorrelates
 *   instead of re-colliding on the next probe.
 * - Rethrows ANY non-EADDRINUSE error immediately and unchanged: real
 *   failures stay loud, never retried, never wrapped.
 * - Exhausts the budget with a clear Error naming the attempts and ports.
 */

import { createServer } from "node:net";
import type { ServeOptions } from "../../src/core/types.js";
import type { ServeInstance } from "../../src/server/server.js";

/** `serve()` target: a file/dir to serve, or undefined for API-only mode. */
export type ServeTarget = string | undefined;

/** Everything `serve()` takes except the port, which this helper owns. */
export type ServeOptionsWithoutPort = Omit<ServeOptions, "port">;

export const SERVE_WITH_PORT_ATTEMPTS = 8;

/** Ports already handed out in this process — never handed out twice. */
const handedOutPorts = new Set<number>();

/** Probe the OS for a loopback port this process has not used before. */
async function pickFreshPort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port: found } = probe.address() as { port: number };
        probe.close(() => resolve(found));
      });
      probe.on("error", reject);
    });
    if (!handedOutPorts.has(port)) {
      handedOutPorts.add(port);
      return port;
    }
    // Probes are cheap and collisions with our own set are rare; loop for
    // another candidate rather than risk a self-collision retry.
  }
}

/** Test seam: injectable bind + port picker so unit tests need no sockets. */
export interface ServeWithPortDeps {
  bind?: (
    target: ServeTarget,
    options: ServeOptions,
  ) => Promise<ServeInstance>;
  pickPort?: () => Promise<number>;
}

/**
 * Boot `serve()` with a fresh port per attempt, retrying EADDRINUSE.
 *
 * @param target  passed straight through to `serve()`.
 * @param options everything except `port` — the helper assigns that.
 * @param maxAttempts bounded retry budget (default 8, minimum 1).
 */
export async function serveWithPort(
  target: ServeTarget,
  options: ServeOptionsWithoutPort,
  maxAttempts: number = SERVE_WITH_PORT_ATTEMPTS,
  deps: ServeWithPortDeps = {},
): Promise<ServeInstance> {
  const bind =
    deps.bind ??
    (async (t: ServeTarget, o: ServeOptions) => {
      // Lazy import: keeps server.js out of the importing file's static
      // module graph (same reason the specs use top-level await import).
      const { serve } = await import("../../src/server/server.js");
      return serve(t, o);
    });
  const pickPort = deps.pickPort ?? pickFreshPort;
  const budget = Math.max(1, Math.floor(maxAttempts));
  const triedPorts: number[] = [];
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= budget; attempt++) {
    const port = await pickPort();
    triedPorts.push(port);
    try {
      return await bind(target, { ...options, port });
    } catch (err) {
      // Real failures stay loud: only a taken port is worth another port.
      if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw err;
      lastErr = err;
      // Jittered backoff: under the full-suite thread pool several workers
      // boot at once, and an immediate retry re-races the same herd for the
      // next probe. Yielding a few ms lets the other binds land first.
      if (attempt < budget) {
        const backoffMs = 5 * attempt + Math.random() * 10;
        await new Promise<void>((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw new Error(
    `serveWithPort: address in use after ${budget} attempt(s) ` +
      `(ports tried: ${triedPorts.join(", ")}). ` +
      `Another worker is racing for ports — raise maxAttempts if this persists.`,
  );
}
