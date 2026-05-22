import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import {
  resolveCopilotToken,
  getCopilotAuthStatus,
  storeCopilotToken,
  clearCopilotToken,
  isGhCliAvailable,
} from "../../src/core/copilot-auth.js";

const execSyncMock = vi.mocked(execSync);

describe("copilot-auth", () => {
  let tempDir: string;
  let originalToken: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-auth-"));
    originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    execSyncMock.mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("resolveCopilotToken prefers GITHUB_TOKEN env", () => {
    process.env.GITHUB_TOKEN = "  ghp_envtoken123  ";
    const resolved = resolveCopilotToken(tempDir);
    expect(resolved).toEqual({ token: "ghp_envtoken123", source: "env" });
  });

  it("storeCopilotToken writes config and resolveCopilotToken reads it", () => {
    storeCopilotToken(tempDir, "ghp_config123");
    const resolved = resolveCopilotToken(tempDir);
    expect(resolved).toEqual({ token: "ghp_config123", source: "config" });

    const configPath = join(tempDir, ".vibeflow", "config.json");
    expect(existsSync(configPath)).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as { copilotToken?: string };
    expect(raw.copilotToken).toBe("ghp_config123");
  });

  it("clearCopilotToken removes token from config", () => {
    storeCopilotToken(tempDir, "ghp_config123");
    clearCopilotToken(tempDir);

    const resolved = resolveCopilotToken(tempDir);
    expect(resolved).toBeNull();
  });

  it("resolveCopilotToken falls back to gh cli token when env/config are absent", () => {
    execSyncMock.mockReturnValue("ghp_ghcli_token\n");
    const resolved = resolveCopilotToken(tempDir);
    expect(resolved).toEqual({ token: "ghp_ghcli_token", source: "gh-cli" });
  });

  it("resolveCopilotToken returns null when no auth source is available", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("gh not available");
    });
    const resolved = resolveCopilotToken(tempDir);
    expect(resolved).toBeNull();
  });

  it("isGhCliAvailable returns true when gh --version succeeds", () => {
    execSyncMock.mockReturnValue("gh version 2.0.0");
    expect(isGhCliAvailable()).toBe(true);
  });

  it("isGhCliAvailable returns false when gh --version fails", () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not installed");
    });
    expect(isGhCliAvailable()).toBe(false);
  });

  it("getCopilotAuthStatus returns unauthenticated when no token", async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error("not installed");
    });

    const status = await getCopilotAuthStatus(tempDir);
    expect(status).toEqual({
      authenticated: false,
      source: null,
      tokenHint: null,
      username: null,
    });
  });

  it("getCopilotAuthStatus resolves username and masks token", async () => {
    // eslint-disable-next-line no-secrets/no-secrets -- fake test token, not a real credential
    process.env.GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "octocat" }),
      }),
    );

    const status = await getCopilotAuthStatus(tempDir);
    expect(status.authenticated).toBe(true);
    expect(status.source).toBe("env");
    expect(status.username).toBe("octocat");
    expect(status.tokenHint).toMatch(/^ghp_ab\.\.\./);
  });

  it("getCopilotAuthStatus handles username lookup failures gracefully", async () => {
    process.env.GITHUB_TOKEN = "ghp_abcdefgh12345678";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const status = await getCopilotAuthStatus(tempDir);
    expect(status.authenticated).toBe(true);
    expect(status.username).toBeNull();
  });

  it("getCopilotAuthStatus masks short tokens (<=8 chars) as ***", async () => {
    process.env.GITHUB_TOKEN = "short12"; // 7 chars
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser" }),
      }),
    );

    const status = await getCopilotAuthStatus(tempDir);
    expect(status.tokenHint).toBe("***");
  });

  it("getCopilotAuthStatus masks exactly 8-char token as ***", async () => {
    process.env.GITHUB_TOKEN = "12345678"; // exactly 8 chars
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser" }),
      }),
    );

    const status = await getCopilotAuthStatus(tempDir);
    expect(status.tokenHint).toBe("***");
  });

  it("getCopilotAuthStatus masks 9-char token with prefix and suffix", async () => {
    process.env.GITHUB_TOKEN = "123456789"; // 9 chars (just above threshold)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "testuser" }),
      }),
    );

    const status = await getCopilotAuthStatus(tempDir);
    // slice(0,6) + "..." + slice(-4) = "123456" + "..." + "6789"
    expect(status.tokenHint).toBe("123456...6789");
  });

  it("getCopilotAuthStatus masks token from config source", async () => {
    storeCopilotToken(tempDir, "ghp_configtoken123456789");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ login: "configuser" }),
      }),
    );

    const status = await getCopilotAuthStatus(tempDir);
    expect(status.source).toBe("config");
    expect(status.tokenHint).toMatch(/^ghp_co\.\.\./);
  });

  it("getCopilotAuthStatus handles non-ok GitHub API response", async () => {
    process.env.GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      }),
    );

    const status = await getCopilotAuthStatus(tempDir);
    expect(status.authenticated).toBe(true);
    expect(status.username).toBeNull();
    expect(status.tokenHint).toBeTruthy();
  });

  it("getCopilotAuthStatus handles empty login field from API", async () => {
    process.env.GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}), // no login field
      }),
    );

    const status = await getCopilotAuthStatus(tempDir);
    expect(status.authenticated).toBe(true);
    expect(status.username).toBeNull();
  });

  it("resolveCopilotToken trims whitespace from config token", () => {
    storeCopilotToken(tempDir, "  ghp_trimmed_token  ");
    const resolved = resolveCopilotToken(tempDir);
    expect(resolved).toEqual({ token: "ghp_trimmed_token", source: "config" });
  });

  it("resolveCopilotToken ignores empty string config token", () => {
    storeCopilotToken(tempDir, "");
    execSyncMock.mockImplementation(() => {
      throw new Error("gh not available");
    });
    const resolved = resolveCopilotToken(tempDir);
    expect(resolved).toBeNull();
  });

  it("resolveCopilotToken ignores whitespace-only config token", () => {
    storeCopilotToken(tempDir, "   ");
    execSyncMock.mockImplementation(() => {
      throw new Error("gh not available");
    });
    const resolved = resolveCopilotToken(tempDir);
    expect(resolved).toBeNull();
  });
});
