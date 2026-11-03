/**
 * MCP auth middleware pins (src/mcp/http.ts → src/mcp/auth.ts).
 *
 * `mcpAuth` is the only gate between the network and the MCP tools, so
 * these tests drive the REAL middleware with stub req/res objects and a
 * hermetic HOME (the token lives at ~/.vibeflow/auth.json):
 *
 * - no token configured: loopback passes, everything else is 401;
 * - token configured: a missing header is 401, a wrong token is 403, the
 *   right Bearer passes — even from loopback (token mode always checks);
 * - a corrupt auth.json is treated as "no token", never a crash;
 * - the client ip falls back to the socket address when Express did not
 *   parse one.
 *
 * A broken gate (loopback bypass in token mode, 401/403 swap, crash on
 * corrupt state) fails these tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mcpAuth } from "../../../src/mcp/auth.js";

// os.homedir() is FROZEN in the threads pool (see
// tests/setup/global-hermetic-home.ts) — setting process.env.HOME cannot
// move it, so the token home is steered through a mock instead.
let mockHome = "";
vi.mock("node:os", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:os")>();
  return { ...mod, homedir: () => mockHome };
});

let home: string;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "mcp-auth-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  home = join(base, "home");
  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  mockHome = home;
});

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function writeToken(token: string): void {
  writeFileSync(
    join(home, ".vibeflow", "auth.json"),
    JSON.stringify({ token }),
    "utf-8",
  );
}

type StubRes = {
  statusCode: number | undefined;
  body: unknown;
  res: { status: (code: number) => unknown; json: (obj: unknown) => unknown };
};

function stubRes(): StubRes {
  const stub: StubRes = {
    statusCode: undefined,
    body: undefined,
    res: undefined as never,
  };
  stub.res = {
    status(code: number) {
      stub.statusCode = code;
      return stub.res;
    },
    json(obj: unknown) {
      stub.body = obj;
      return stub.res;
    },
  };
  return stub;
}

function req(ip: string | undefined, authHeader?: string) {
  return {
    ip,
    socket: { remoteAddress: ip ?? "" },
    headers: authHeader ? { authorization: authHeader } : {},
  };
}

describe("mcpAuth without a configured token (local mode)", () => {
  it("lets loopback requests through", () => {
    const stub = stubRes();
    let passed = false;
    mcpAuth(req("127.0.0.1") as never, stub.res as never, () => {
      passed = true;
    });
    expect(passed).toBe(true);
    expect(stub.statusCode).toBeUndefined();
  });

  it("refuses non-loopback requests with 401", () => {
    const stub = stubRes();
    let passed = false;
    mcpAuth(req("192.168.1.10") as never, stub.res as never, () => {
      passed = true;
    });
    expect(passed).toBe(false);
    expect(stub.statusCode).toBe(401);
    expect(stub.body).toMatchObject({ error: "Unauthorized" });
  });

  it("falls back to the socket address when Express parsed no ip", () => {
    const stub = stubRes();
    let passed = false;
    mcpAuth(
      { ip: undefined, socket: { remoteAddress: "10.0.0.5" }, headers: {} } as never,
      stub.res as never,
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(false);
    expect(stub.statusCode).toBe(401);
  });

  it("treats a corrupt auth.json as no token instead of crashing", () => {
    writeFileSync(join(home, ".vibeflow", "auth.json"), "{nope", "utf-8");
    const stub = stubRes();
    let passed = false;
    mcpAuth(req("127.0.0.1") as never, stub.res as never, () => {
      passed = true;
    });
    expect(passed).toBe(true);
  });
});

describe("mcpAuth with a configured token", () => {
  beforeEach(() => {
    writeToken("secret-token");
  });

  it("passes the correct Bearer token", () => {
    const stub = stubRes();
    let passed = false;
    mcpAuth(
      req("127.0.0.1", "Bearer secret-token") as never,
      stub.res as never,
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(true);
  });

  it("refuses a missing Authorization header with 401, even from loopback", () => {
    const stub = stubRes();
    let passed = false;
    mcpAuth(req("127.0.0.1") as never, stub.res as never, () => {
      passed = true;
    });
    expect(passed).toBe(false);
    expect(stub.statusCode).toBe(401);
    expect(stub.body).toMatchObject({ error: "Unauthorized" });
  });

  it("refuses a wrong Bearer token with 403", () => {
    const stub = stubRes();
    let passed = false;
    mcpAuth(
      req("127.0.0.1", "Bearer wrong-token") as never,
      stub.res as never,
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(false);
    expect(stub.statusCode).toBe(403);
    expect(stub.body).toMatchObject({ error: "Forbidden" });
  });
});
