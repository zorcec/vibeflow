/**
 * Unit tests for the shared serve() boot helper (tests/helpers/serve-with-port).
 *
 * No sockets: bind + port picker are injected, so EADDRINUSE is simulated
 * deterministically instead of raced for.
 */

import { describe, it, expect, vi } from "vitest";
import {
  serveWithPort,
  SERVE_WITH_PORT_ATTEMPTS,
} from "../../helpers/serve-with-port.js";
import type { ServeInstance } from "../../../src/server/server.js";
import type { ServeOptions } from "../../../src/core/types.js";

function eaddrinuse(port: number): NodeJS.ErrnoException {
  return Object.assign(
    new Error(
      `listen EADDRINUSE: address already in use 127.0.0.1:${port}`,
    ),
    { code: "EADDRINUSE" },
  );
}

function fakeInstance(): ServeInstance {
  return {
    url: "http://localhost:9",
    guide: {},
    close: async () => {},
  } as unknown as ServeInstance;
}

describe("serveWithPort", () => {
  it("retries a fresh port after EADDRINUSE and returns the instance", async () => {
    const seenPorts: number[] = [];
    const bind = vi.fn(
      async (_t: string | undefined, o: ServeOptions) => {
        seenPorts.push(o.port);
        if (o.port === 50001) throw eaddrinuse(o.port);
        return fakeInstance();
      },
    );
    const ports = [50001, 50002];
    const got = await serveWithPort(
      undefined,
      { open: false, projectDir: "/tmp/x" },
      5,
      { bind, pickPort: async () => ports.shift()! },
    );
    expect(got.url).toBe("http://localhost:9");
    expect(bind).toHaveBeenCalledTimes(2);
    expect(seenPorts).toEqual([50001, 50002]);
  });

  it("rethrows a non-EADDRINUSE error immediately and unchanged", async () => {
    const boom = new Error("baseline boom");
    const bind = vi.fn(async () => {
      throw boom;
    });
    await expect(
      serveWithPort(undefined, { open: false }, 5, {
        bind,
        pickPort: async () => 50003,
      }),
    ).rejects.toBe(boom);
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("fails with attempts and ports named when the budget is exhausted", async () => {
    const bind = vi.fn(async (_t: string | undefined, o: ServeOptions) => {
      throw eaddrinuse(o.port);
    });
    const ports = [51001, 51002, 51003];
    await expect(
      serveWithPort(undefined, { open: false }, 3, {
        bind,
        pickPort: async () => ports.shift()!,
      }),
    ).rejects.toThrow(
      /address in use after 3 attempt\(s\) \(ports tried: 51001, 51002, 51003\)/,
    );
    expect(bind).toHaveBeenCalledTimes(3);
  });

  it("retries at least five times by default", async () => {
    expect(SERVE_WITH_PORT_ATTEMPTS).toBeGreaterThanOrEqual(5);
    const bind = vi.fn(async (_t: string | undefined, o: ServeOptions) => {
      throw eaddrinuse(o.port);
    });
    let next = 52000;
    await expect(
      serveWithPort(undefined, { open: false }, undefined, {
        bind,
        pickPort: async () => next++,
      }),
    ).rejects.toThrow(
      new RegExp(
        `address in use after ${SERVE_WITH_PORT_ATTEMPTS} attempt`,
      ),
    );
    expect(bind).toHaveBeenCalledTimes(SERVE_WITH_PORT_ATTEMPTS);
  });
});
