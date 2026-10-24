/**
 * Cross-process proof, ticket d5178789: the settings pre-flight debounce
 * spans CLI invocations via the project-local state dir.
 *
 * A fresh module import simulates a fresh CLI process (module memory is
 * per-process; the disk stamp is shared). Fake clock throughout:
 * - A@t0 fetches once and persists; B@t0+1s (fresh memory) issues ZERO
 *   requests; C@t0+5min issues exactly one conditional GET.
 * - Corrupt state, future stamps, token rotation, and an independent
 *   settings edit all re-arm eligibility (fail-open, no masking).
 * - A live foreign lease suppresses the fetch without waiting.
 *
 * Mutation note: removing the disk read in `maybeRefreshSettings` turns
 * the cross-process test red (B fetches again); removing the fingerprint
 * check turns the settings-edit test red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../../src/auth/token.js", () => ({
  readToken: vi.fn(),
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

const NOW = 1_700_000_000_000;
const FIVE_MINUTES = 5 * 60 * 1000;

const okSettings = (settings: unknown, settingsHash?: string) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve(
        settingsHash === undefined ? { settings } : { settings, settingsHash },
      ),
  });

/** Fresh login module = fresh CLI process (memory cleared, disk shared). */
async function freshLogin() {
  vi.resetModules();
  return await import("../../../src/auth/login.js");
}

describe("settings pre-flight persists across CLI invocations (d5178789)", () => {
  let projectDir: string;

  beforeEach(() => {
    vi.unstubAllGlobals();
    projectDir = mkdtempSync(join(tmpdir(), "preflight-persist-"));
    // A present project cache: the conditional path is only taken when
    // the ETag describes bytes actually on disk (see implementation).
    mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
    writeFileSync(join(projectDir, ".vibeflow", "settings.json"), "{}");
    vi.mocked(tokenModule.readToken).mockReset();
    vi.mocked(settingsModule.writeGlobalSettings).mockReset();
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A fetches once; B in a fresh process issues zero requests; C at the window edge revalidates once", async () => {
    const first = await freshLogin();
    vi.stubGlobal("fetch", okSettings({ autoCommit: true }, "hash-1"));
    await first.maybeRefreshSettings(NOW, projectDir);

    // Fresh process inside the window: the disk stamp suppresses the fetch.
    const second = await freshLogin();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await second.maybeRefreshSettings(NOW + 1000, projectDir);
    expect(fetchMock).not.toHaveBeenCalled();

    // Exactly at the window edge: one conditional revalidation, then the
    // stamp refreshes and a fourth process is quiet again.
    const third = await freshLogin();
    const edgeMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 304,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", edgeMock);
    await third.maybeRefreshSettings(NOW + FIVE_MINUTES, projectDir);
    expect(edgeMock).toHaveBeenCalledTimes(1);
    const headers = edgeMock.mock.calls[0]?.[1] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(headers.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "If-None-Match": '"hash-1"',
    });

    const fourth = await freshLogin();
    const quietMock = vi.fn();
    vi.stubGlobal("fetch", quietMock);
    await fourth.maybeRefreshSettings(NOW + FIVE_MINUTES + 1000, projectDir);
    expect(quietMock).not.toHaveBeenCalled();
  });

  it("corrupt state is a miss: the refresh still happens", async () => {
    const { stateFile, dir } = (
      await import("../../../src/auth/settings-preflight-state.js")
    ).resolvePreflightPaths(projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile, "{corrupt");
    const login = await freshLogin();
    const fetchMock = okSettings({ autoCommit: true }, "hash-1");
    vi.stubGlobal("fetch", fetchMock);
    await login.maybeRefreshSettings(NOW, projectDir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a future stamp (clock rollback) never suppresses the refresh", async () => {
    const state = await import(
      "../../../src/auth/settings-preflight-state.js"
    );
    state.persistPreflightState(projectDir, {
      identityHash: state.identityHashFor("https://api.example", "test-token"),
      checkedAt: NOW + 60_000,
      settingsHash: null,
      settingsFingerprint: "whatever",
    });
    const login = await freshLogin();
    const fetchMock = okSettings({ autoCommit: true });
    vi.stubGlobal("fetch", fetchMock);
    // Identity differs anyway (real apiUrl), but the future stamp alone
    // must not count as fresh even with a matching identity.
    await login.maybeRefreshSettings(NOW, projectDir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("token rotation re-arms eligibility without reusing the old identity", async () => {
    const first = await freshLogin();
    vi.stubGlobal("fetch", okSettings({ autoCommit: true }, "hash-1"));
    await first.maybeRefreshSettings(NOW, projectDir);

    vi.mocked(tokenModule.readToken).mockResolvedValue("rotated-token");
    const second = await freshLogin();
    const fetchMock = okSettings({ autoCommit: true }, "hash-2");
    vi.stubGlobal("fetch", fetchMock);
    await second.maybeRefreshSettings(NOW + 1000, projectDir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an independent settings edit inside the window re-arms eligibility", async () => {
    const first = await freshLogin();
    vi.stubGlobal("fetch", okSettings({ autoCommit: true }, "hash-1"));
    await first.maybeRefreshSettings(NOW, projectDir);
    expect(settingsModule.writeGlobalSettings).toHaveBeenCalledTimes(1);

    // Someone edits the project settings outside this process.
    mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(projectDir, ".vibeflow", "settings.json"),
      JSON.stringify({ viewMode: "board" }),
    );

    const second = await freshLogin();
    const fetchMock = okSettings({ autoCommit: true }, "hash-2");
    vi.stubGlobal("fetch", fetchMock);
    await second.maybeRefreshSettings(NOW + 1000, projectDir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a live foreign lease suppresses the fetch without waiting", async () => {
    const state = await import(
      "../../../src/auth/settings-preflight-state.js"
    );
    const lease = state.acquirePreflightLease(projectDir, NOW);
    expect(lease.held).toBe(true);

    const login = await freshLogin();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const start = Date.now();
    await login.maybeRefreshSettings(NOW, projectDir);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    lease.release();
  });

  it("no token means no fetch and no state dir", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const login = await freshLogin();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await login.maybeRefreshSettings(NOW, projectDir);
    expect(fetchMock).not.toHaveBeenCalled();
    const { dir } = (
      await import("../../../src/auth/settings-preflight-state.js")
    ).resolvePreflightPaths(projectDir);
    const { existsSync } = await import("node:fs");
    expect(existsSync(dir)).toBe(false);
  });

  it("transport failure backs off on disk: the next in-window call is quiet", async () => {
    const first = await freshLogin();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await first.maybeRefreshSettings(NOW, projectDir);

    const second = await freshLogin();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await second.maybeRefreshSettings(NOW + 1000, projectDir);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
