import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock all heavy dependencies before importing the module under test.
vi.mock("../../../src/auth/token.js", () => ({
  readToken: vi.fn(),
  writeToken: vi.fn(),
}));
vi.mock("../../../src/core/settings.js", () => ({
  readGlobalSettings: vi.fn(),
  writeGlobalSettings: vi.fn(),
}));
vi.mock("../../../src/auth/workspace.js", () => ({
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
}));
vi.mock("open", () => ({ default: vi.fn() }));
vi.mock("@inquirer/select", () => ({ default: vi.fn() }));
// login() -> promptPushLocalTasks may find local .vibeflow/tasks files and
// prompt on stdin. Auto-answer so the prompt never blocks the test.
vi.mock("node:readline", () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: vi.fn((_prompt: string, onAnswer: (answer: string) => void) => {
        onAnswer("n");
      }),
      close: vi.fn(),
    })),
  },
}));

import * as tokenModule from "../../../src/auth/token.js";
import * as settingsModule from "../../../src/core/settings.js";
import * as workspaceModule from "../../../src/auth/workspace.js";
import {
  maybeRefreshSettings,
  resetSettingsPreflight,
  login,
} from "../../../src/auth/login.js";

const selectMock = (await import("@inquirer/select")).default as ReturnType<typeof vi.fn>;
const openMock = (await import("open")).default as ReturnType<typeof vi.fn>;

const FIVE_MINUTES = 5 * 60 * 1000;

describe("maybeRefreshSettings pre-flight (cca4bfe4)", () => {
  // Fixed clock: the pre-flight takes an injectable `now` so the 5-minute
  // window is deterministic without fake timers.
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(tokenModule.readToken).mockReset();
    vi.mocked(settingsModule.readGlobalSettings).mockReset();
    vi.mocked(settingsModule.writeGlobalSettings).mockReset();
    resetSettingsPreflight();
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSettingsPreflight();
  });

  const okSettings = (settings: unknown, settingsHash?: string) =>
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          settingsHash === undefined ? { settings } : { settings, settingsHash },
        ),
    });

  it("skips refresh when no token is stored", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await maybeRefreshSettings(NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(settingsModule.writeGlobalSettings).not.toHaveBeenCalled();
  });

  it("cold start fetches once without If-None-Match and stores the hash", async () => {
    const fetchMock = okSettings({ autoCommit: true }, "hash-1");
    vi.stubGlobal("fetch", fetchMock);

    await maybeRefreshSettings(NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(headers.headers).toEqual({ Authorization: "Bearer test-token" });
    expect(headers.headers).not.toHaveProperty("If-None-Match");
    expect(settingsModule.writeGlobalSettings).toHaveBeenCalledWith({
      autoCommit: true,
    });
    // No freshness timestamp is persisted — freshness lives in the
    // in-memory checkedAt only (ticket cca4bfe4).
    expect(settingsModule.writeGlobalSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ _settingsRefreshedAt: expect.anything() }),
    );
  });

  it("cached path costs zero requests (in-window recheck, ~0 ms)", async () => {
    vi.stubGlobal("fetch", okSettings({ autoCommit: true }, "hash-1"));
    await maybeRefreshSettings(NOW);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const start = Date.now();
    await maybeRefreshSettings(NOW + 1000);
    const elapsed = Date.now() - start;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(50);
  });

  it("no-change run after the window costs exactly one conditional request", async () => {
    vi.stubGlobal("fetch", okSettings({ autoCommit: true }, "hash-1"));
    await maybeRefreshSettings(NOW);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 304,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await maybeRefreshSettings(NOW + FIVE_MINUTES + 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(headers.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "If-None-Match": '"hash-1"',
    });
    // 304 → nothing else happens: no merge, no second disk write.
    expect(settingsModule.writeGlobalSettings).toHaveBeenCalledTimes(1);
  });

  it("changed hash re-merges once and stores the new pair", async () => {
    vi.stubGlobal("fetch", okSettings({ autoCommit: true }, "hash-1"));
    await maybeRefreshSettings(NOW);

    const fetchMock = okSettings({ autoCommit: false }, "hash-2");
    vi.stubGlobal("fetch", fetchMock);
    await maybeRefreshSettings(NOW + FIVE_MINUTES + 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settingsModule.writeGlobalSettings).toHaveBeenCalledTimes(2);
    expect(settingsModule.writeGlobalSettings).toHaveBeenLastCalledWith({
      autoCommit: false,
    });
  });

  it("does not throw when token read throws", async () => {
    vi.mocked(tokenModule.readToken).mockRejectedValue(new Error("fs error"));

    await expect(maybeRefreshSettings(NOW)).resolves.toBeUndefined();
  });

  it("fail-open: fetch failure keeps cached settings and backs off", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(maybeRefreshSettings(NOW)).resolves.toBeUndefined();
    expect(settingsModule.writeGlobalSettings).not.toHaveBeenCalled();
    // Back-off: an immediate retry costs no request either.
    await maybeRefreshSettings(NOW + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes a short abort signal so a hung server cannot block the command", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: unknown, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Promise.reject(new Error("network down"));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(maybeRefreshSettings(NOW)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite settings when API returns empty object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ settings: {} }),
      }),
    );

    await maybeRefreshSettings(NOW);

    // Empty settings object (no keys) → should NOT write
    expect(settingsModule.writeGlobalSettings).not.toHaveBeenCalled();
  });

  it("does not overwrite settings when API returns non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await maybeRefreshSettings(NOW);

    expect(settingsModule.writeGlobalSettings).not.toHaveBeenCalled();
    // Fail-open back-off still applies to non-ok answers.
    await maybeRefreshSettings(NOW + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses VIBEFLOW_API_URL environment variable when set", async () => {
    const originalEnv = process.env.VIBEFLOW_API_URL;
    process.env.VIBEFLOW_API_URL = "http://custom-server:4000";
    try {
      const fetchMock = okSettings({ debug: true }, "hash-1");
      vi.stubGlobal("fetch", fetchMock);

      await maybeRefreshSettings(NOW);

      const callUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(callUrl).toContain("http://custom-server:4000");
    } finally {
      process.env.VIBEFLOW_API_URL = originalEnv;
    }
  });

  it("merges without a hash from an old server, then rechecks unconditionally", async () => {
    vi.stubGlobal("fetch", okSettings({ autoCommit: true }));
    await maybeRefreshSettings(NOW);
    expect(settingsModule.writeGlobalSettings).toHaveBeenCalledTimes(1);

    const fetchMock = okSettings({ autoCommit: true });
    vi.stubGlobal("fetch", fetchMock);
    await maybeRefreshSettings(NOW + FIVE_MINUTES + 1);

    const headers = fetchMock.mock.calls[0]?.[1] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(headers.headers).not.toHaveProperty("If-None-Match");
  });

  it("triggers refresh when the window ends exactly at the boundary", async () => {
    const fetchMock = okSettings({ debug: true }, "hash-1");
    vi.stubGlobal("fetch", fetchMock);

    await maybeRefreshSettings(NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // At exactly the boundary, should trigger refresh (interval is < not <=)
    await maybeRefreshSettings(NOW + FIVE_MINUTES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchAndSelectWorkspace (via login flow)", () => {
  beforeEach(() => {
    vi.mocked(tokenModule.readToken).mockReset();
    vi.mocked(settingsModule.readGlobalSettings).mockReset();
    vi.mocked(settingsModule.writeGlobalSettings).mockReset();
    vi.mocked(workspaceModule.writeWorkspace).mockReset();
    vi.mocked(workspaceModule.readWorkspace).mockReset();
    selectMock.mockReset();
    openMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches workspaces and writes selected workspace on successful login", async () => {
    const workspace = { id: "ws-1", name: "My Board", url: "http://localhost:3000", icon: "📋", email: null };

    // Mock device-init
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          deviceCode: "device-123",
          userCode: "ABCD-1234",
          verificationUrl: "http://localhost:3000/activate",
          expiresIn: 1,
        }),
      })
      // Mock device-poll → success
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: "vbf_pat_abcdef01_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOpq" }),
      })
      // Mock profile fetch (profile is read before the boards list)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ email: "user@example.com" }),
      })
      // Mock settings fetch — issued concurrently with the boards fetch
      // (Promise.all), so it answers the 4th call, before boards pages.
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ settings: { autoCommit: true } }),
      })
      // Mock boards fetch — the v0 envelope: { items, nextCursor }
      // (ticket 3ac40717: the old { workspaces } parse saw no boards here)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [workspace], nextCursor: null }),
      })
      // Mock tasks-listing fetch (promptPushLocalTasks)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });

    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(workspace);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await login();

    // Workspace should be written with email from profile
    expect(workspaceModule.writeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws-1", email: "user@example.com" }),
    );
    // A board WAS found, so the empty-account guidance must not print.
    expect(logSpy.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain(
      "No boards found",
    );
  });

  it("keeps the legacy { workspaces } boards envelope working", async () => {
    const workspace = { id: "ws-9", name: "Legacy Board", url: "http://localhost:3000", icon: null, email: null };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          deviceCode: "device-123",
          userCode: "ABCD-1234",
          verificationUrl: "http://localhost:3000/activate",
          expiresIn: 1,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: "vbf_pat_abcdef01_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOpq" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ email: "legacy@example.com" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ settings: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ workspaces: [workspace], nextCursor: null }),
      });

    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await login();

    expect(workspaceModule.writeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws-9", email: "legacy@example.com" }),
    );
  });

  it("follows boards pagination cursors until nextCursor is null", async () => {
    const boardA = { id: "b-a", name: "Board A" };
    const boardB = { id: "b-b", name: "Board B" };
    selectMock.mockResolvedValueOnce({ id: "b-b", name: "Board B", icon: null, url: "http://localhost:3000", email: null });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          deviceCode: "device-123",
          userCode: "ABCD-1234",
          verificationUrl: "http://localhost:3000/activate",
          expiresIn: 1,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: "vbf_pat_abcdef01_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOpq" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ email: "paged@example.com" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ settings: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [boardA], nextCursor: "cursor-1" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [boardB], nextCursor: null }),
      });

    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await login();

    const boardCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/v0/boards"),
    );
    expect(boardCalls).toHaveLength(2);
    expect(String(boardCalls[1]?.[0])).toContain("cursor=cursor-1");
    expect(workspaceModule.writeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b-b", email: "paged@example.com" }),
    );
  });

  it("prints next-step guidance (not just the empty message) when the account has no boards", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          deviceCode: "device-123",
          userCode: "ABCD-1234",
          verificationUrl: "http://localhost:3000/activate",
          expiresIn: 1,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: "vbf_pat_abcdef01_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOpq" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ email: "empty@example.com" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ settings: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [], nextCursor: null }),
      });

    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await login();

    expect(workspaceModule.writeWorkspace).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain("No boards found on this account yet.");
    expect(printed).toContain("vibeflow auth login");
  });

  it("hits the v0 device-auth paths (no bearer on auth infrastructure)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          deviceCode: "device-123",
          userCode: "ABCD-1234",
          verificationUrl: "http://localhost:3000/activate",
          expiresIn: 1,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ expired: true }),
      });

    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await login();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/v0\/auth\/device-init$/);
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/api\/v0\/auth\/device-poll$/);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).headers ?? {}).not.toMatchObject({
        Authorization: expect.anything(),
      });
    }
  });

  it("stores the device-flow PAT and sends it as Bearer on cloud calls", async () => {
    const pat =
      "vbf_pat_01234567_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno";
    const workspace = { id: "ws-1", name: "My Board", url: "http://localhost:3000", icon: "📋", email: null };
    vi.mocked(tokenModule.writeToken).mockClear();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          deviceCode: "device-123",
          userCode: "ABCD-1234",
          verificationUrl: "http://localhost:3000/activate",
          expiresIn: 1,
        }),
      })
      // Device-poll hands out the PAT plaintext exactly once.
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: pat }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ workspaces: [workspace] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ email: "user@example.com" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ settings: { autoCommit: true } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });

    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(workspace);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await login();

    // The PAT is stored verbatim …
    expect(tokenModule.writeToken).toHaveBeenCalledWith(pat);
    // … and rides as the Bearer credential on every follow-up cloud call
    // (boards, profile, settings, tasks — all /api/v0 via surfacePath).
    // Calls 0–1 are device-init/poll, which carry no Authorization header.
    const authedCalls = fetchMock.mock.calls.slice(2);
    expect(authedCalls.length).toBeGreaterThan(0);
    for (const call of authedCalls) {
      expect((call[1] as RequestInit).headers).toMatchObject({
        Authorization: `Bearer ${pat}`,
      });
    }
  });

  it("handles empty workspaces list gracefully", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          deviceCode: "device-123",
          userCode: "ABCD-1234",
          verificationUrl: "http://localhost:3000/activate",
          expiresIn: 1,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: "vbf_pat_abcdef01_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOpq" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ workspaces: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ email: "user@example.com" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ settings: {} }),
      });

    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await login();

    // No workspace should be written when list is empty
    expect(workspaceModule.writeWorkspace).not.toHaveBeenCalled();
  });

  it("handles workspace fetch failure gracefully", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          deviceCode: "device-123",
          userCode: "ABCD-1234",
          verificationUrl: "http://localhost:3000/activate",
          expiresIn: 1,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ token: "vbf_pat_abcdef01_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOpq" }),
      })
      .mockResolvedValueOnce({
        ok: false, // workspace fetch fails
        status: 500,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ settings: {} }),
      });

    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Should not throw
    await expect(login()).resolves.toBeUndefined();
  });

  it("handles login timeout when device code expires", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          deviceCode: "device-123",
          userCode: "ABCD-1234",
          verificationUrl: "http://localhost:3000/activate",
          expiresIn: 0, // expires immediately
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ expired: true }),
      });

    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await login();

    expect(process.exitCode).toBe(4);
  });

  it("handles device-init failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
    }));

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await login();

    expect(process.exitCode).toBe(4);
  });
});

describe("login — never opens a browser when it should not", () => {
  /**
   * `vibeflow login` used to shell out to the `open` package unconditionally,
   * which on Linux means `xdkg-open` and a REAL browser tab. In CI, in a script
   * and in the web e2e suite that produced surprise tabs at
   * `…/cli/verify?code=…` on the developer's desktop, pointing at a throwaway
   * instance. These lock in the two conditions that prevent it, and — just as
   * importantly — that the URL is still printed when the browser is suppressed,
   * so nothing is lost by not opening it.
   */
  const realIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.stdout.isTTY = realIsTTY;
    delete process.env.VIBEFLOW_NO_BROWSER;
    vi.clearAllMocks();
  });

  async function runLogin() {
    const { login } = await import("../../../src/auth/login.js");
    const open = (await import("open")).default as unknown as ReturnType<
      typeof vi.fn
    >;
    // Make the device code expire immediately so login() returns without needing
    // a browser interaction.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("device-init")) {
          return {
            ok: true,
            json: async () => ({
              deviceCode: "dev-code",
              userCode: "ABCD1234",
              verificationUrl: "http://localhost:3000/cli/verify?code=ABCD1234",
              expiresIn: 0,
            }),
          } as unknown as Response;
        }
        return { ok: true, json: async () => ({ expired: true }) } as unknown as Response;
      }),
    );
    await login("/tmp");
    return open;
  }

  it("does not open a browser when VIBEFLOW_NO_BROWSER=1", async () => {
    process.env.VIBEFLOW_NO_BROWSER = "1";
    process.stdout.isTTY = true;
    const open = await runLogin();
    expect(open).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not open a browser when stdout is not a TTY (CI, pipes, harnesses)", async () => {
    process.stdout.isTTY = false;
    const open = await runLogin();
    expect(open).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("still prints the verification URL when the browser is suppressed", async () => {
    process.env.VIBEFLOW_NO_BROWSER = "1";
    process.stdout.isTTY = true;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const open = await runLogin();
    const printed = log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(open).not.toHaveBeenCalled();
    // Suppressing the browser must not suppress the instructions.
    expect(printed).toContain("http://localhost:3000/cli/verify?code=ABCD1234");
    log.mockRestore();
    vi.unstubAllGlobals();
  });

  it("DOES open a browser for an interactive terminal, when allowed", async () => {
    delete process.env.VIBEFLOW_NO_BROWSER;
    process.stdout.isTTY = true;
    const open = await runLogin();
    expect(open).toHaveBeenCalledWith(
      "http://localhost:3000/cli/verify?code=ABCD1234",
    );
    vi.unstubAllGlobals();
  });
});
