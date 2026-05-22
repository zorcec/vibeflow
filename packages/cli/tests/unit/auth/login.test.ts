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

import * as tokenModule from "../../../src/auth/token.js";
import * as settingsModule from "../../../src/core/settings.js";
import * as workspaceModule from "../../../src/auth/workspace.js";
import { maybeRefreshSettings, login } from "../../../src/auth/login.js";

const selectMock = (await import("@inquirer/select")).default as ReturnType<typeof vi.fn>;
const openMock = (await import("open")).default as ReturnType<typeof vi.fn>;

const FIVE_MINUTES = 5 * 60 * 1000;

describe("maybeRefreshSettings", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(tokenModule.readToken).mockReset();
    vi.mocked(settingsModule.readGlobalSettings).mockReset();
    vi.mocked(settingsModule.writeGlobalSettings).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips refresh when no token is stored", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);

    await maybeRefreshSettings();

    expect(settingsModule.readGlobalSettings).not.toHaveBeenCalled();
    expect(settingsModule.writeGlobalSettings).not.toHaveBeenCalled();
  });

  it("skips refresh when settings were refreshed within the last 5 minutes", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(settingsModule.readGlobalSettings).mockReturnValue({
      _settingsRefreshedAt: Date.now() - 1000, // refreshed 1 second ago
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await maybeRefreshSettings();

    // Settings are fresh — no API call should be made
    expect(fetchMock).not.toHaveBeenCalled();
    expect(settingsModule.writeGlobalSettings).not.toHaveBeenCalled();
  });

  it("fires a background settings fetch when last refresh is older than 5 minutes", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(settingsModule.readGlobalSettings).mockReturnValue({
      _settingsRefreshedAt: Date.now() - FIVE_MINUTES - 1000, // stale
    });

    const mockSettings = { autoCommit: true };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ settings: mockSettings }),
      }),
    );

    await maybeRefreshSettings();

    // Give the background fire-and-forget time to complete in tests
    await new Promise((r) => setTimeout(r, 10));

    // The background fetch should write updated settings
    expect(settingsModule.writeGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ autoCommit: true }),
    );
  });

  it("does not throw when token read throws", async () => {
    vi.mocked(tokenModule.readToken).mockRejectedValue(new Error("fs error"));

    await expect(maybeRefreshSettings()).resolves.toBeUndefined();
  });

  it("does not throw when settings read throws", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(settingsModule.readGlobalSettings).mockImplementation(() => {
      throw new Error("settings corrupted");
    });

    await expect(maybeRefreshSettings()).resolves.toBeUndefined();
  });

  it("does not throw when fetch fails (non-critical background call)", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(settingsModule.readGlobalSettings).mockReturnValue({
      _settingsRefreshedAt: 0, // very stale → will trigger fetch
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(maybeRefreshSettings()).resolves.toBeUndefined();
  });

  it("does not overwrite settings when API returns empty object", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(settingsModule.readGlobalSettings).mockReturnValue({
      _settingsRefreshedAt: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ settings: {} }),
      }),
    );

    await maybeRefreshSettings();
    await new Promise((r) => setTimeout(r, 10));

    // Empty settings object (no keys) → should NOT write
    expect(settingsModule.writeGlobalSettings).not.toHaveBeenCalled();
  });

  it("does not overwrite settings when API returns non-ok response", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(settingsModule.readGlobalSettings).mockReturnValue({
      _settingsRefreshedAt: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({}),
      }),
    );

    await maybeRefreshSettings();
    await new Promise((r) => setTimeout(r, 10));

    expect(settingsModule.writeGlobalSettings).not.toHaveBeenCalled();
  });

  it("uses VIBEFLOW_API_URL environment variable when set", async () => {
    const originalEnv = process.env.VIBEFLOW_API_URL;
    process.env.VIBEFLOW_API_URL = "http://custom-server:4000";

    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(settingsModule.readGlobalSettings).mockReturnValue({
      _settingsRefreshedAt: 0,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ settings: { debug: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await maybeRefreshSettings();
    // Give the fire-and-forget promise time to start the fetch call
    await new Promise((r) => setTimeout(r, 50));

    const callUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(callUrl).toContain("http://custom-server:4000");

    process.env.VIBEFLOW_API_URL = originalEnv;
  });

  it("fires background fetch with Authorization header when settings are stale", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("my-secret-token");
    vi.mocked(settingsModule.readGlobalSettings).mockReturnValue({
      _settingsRefreshedAt: 0, // very stale
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ settings: { autoCommit: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await maybeRefreshSettings();
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).toHaveBeenCalled();
    const fetchOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchOptions.headers).toEqual({
      Authorization: "Bearer my-secret-token",
    });
  });

  it("does not write settings when background fetch returns non-ok", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(settingsModule.readGlobalSettings).mockReturnValue({
      _settingsRefreshedAt: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      }),
    );

    await maybeRefreshSettings();
    await new Promise((r) => setTimeout(r, 50));

    expect(settingsModule.writeGlobalSettings).not.toHaveBeenCalled();
  });

  it("triggers refresh when last refresh is exactly at boundary (5 minutes ago)", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(settingsModule.readGlobalSettings).mockReturnValue({
      _settingsRefreshedAt: Date.now() - FIVE_MINUTES, // exactly at boundary
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ settings: { debug: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await maybeRefreshSettings();
    await new Promise((r) => setTimeout(r, 50));

    // At exactly the boundary, should trigger refresh (interval is < not <=)
    expect(fetchMock).toHaveBeenCalled();
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
        json: () => Promise.resolve({ token: "test-token-123" }),
      })
      // Mock workspaces fetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ workspaces: [workspace] }),
      })
      // Mock profile fetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ email: "user@example.com" }),
      })
      // Mock settings fetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ settings: { autoCommit: true } }),
      });

    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(workspace);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await login();

    // Workspace should be written with email from profile
    expect(workspaceModule.writeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws-1", email: "user@example.com" }),
    );
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
        json: () => Promise.resolve({ token: "test-token-123" }),
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
        json: () => Promise.resolve({ token: "test-token-123" }),
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

    expect(process.exitCode).toBe(1);
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

    expect(process.exitCode).toBe(1);
  });
});
