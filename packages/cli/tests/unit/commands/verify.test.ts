import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock node:fs first (before any imports) ──────────────────────────────
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue("{}"),
  };
});

// ── Mock playwright with proper factory ───────────────────────────────────
const mockElement = {
  evaluate: vi.fn().mockResolvedValue("<div>test</div>"),
  boundingBox: vi
    .fn()
    .mockResolvedValue({ x: 100, y: 200, width: 120, height: 40 }),
};
const mockLocatorObj = {
  first: vi.fn().mockReturnValue(mockElement),
  count: vi.fn().mockResolvedValue(1),
  evaluate: mockElement.evaluate,
  boundingBox: mockElement.boundingBox,
};
const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  locator: vi.fn().mockReturnValue(mockLocatorObj),
  evaluate: vi.fn().mockImplementation((fn: Function) => {
    try {
      const result = fn({
        scrollX: 0,
        scrollY: 0,
        innerWidth: 1280,
        innerHeight: 720,
        devicePixelRatio: 2,
        localStorage: { setItem: vi.fn() },
        sessionStorage: { setItem: vi.fn() },
      });
      return Promise.resolve(result);
    } catch {
      return Promise.resolve({});
    }
  }),
  on: vi.fn(),
};
const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  addCookies: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};
const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("playwright", () => ({
  chromium: { launch: vi.fn().mockResolvedValue(mockBrowser) },
}));

// ── Mock core modules ─────────────────────────────────────────────────────
vi.mock("../../../src/core/tasks.js", () => ({
  findTaskFilePath: vi.fn(),
  readTaskFile: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("../../../src/core/files.js", () => ({
  saveFile: vi.fn(),
  getFilesDir: vi
    .fn()
    .mockImplementation((projectDir: string, taskId: string) =>
      join(projectDir, ".vibeflow", "tasks", "files", taskId),
    ),
}));

vi.mock("../../../src/core/comments.js", () => ({
  addComment: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────
import * as tasksModule from "../../../src/core/tasks.js";
import * as filesModule from "../../../src/core/files.js";
import * as commentsModule from "../../../src/core/comments.js";
import { verifyTask, runVerify } from "../../../src/commands/verify.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "verify-test-"));
}

function makeBaseline() {
  return {
    outerHTML: '<button class="submit">Submit</button>',
    computedStyles: { "background-color": "#EF4444", color: "#FFFFFF" },
    selector: ".submit",
    position: {
      boundingBox: { x: 100, y: 200, width: 120, height: 40 },
      scrollPosition: { x: 0, y: 0 },
      viewport: { width: 1280, height: 720, dpr: 2 },
      stackingContext: { zIndex: "auto", position: "relative" },
    },
    browser: "Mozilla/5.0",
    consoleErrors: [],
    capturedAt: "2026-08-28T22:07:00.000Z",
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-task-123",
    title: "Test task",
    description: "Fix submit button color to blue",
    status: "in-progress",
    selector: ".submit",
    cssSelector: ".submit",
    url: "http://localhost:5173/form",
    author: "alice",
    created: "2026-08-28T22:00:00.000Z",
    baseline: makeBaseline(),
    ...overrides,
  };
}

function resetMocks() {
  vi.clearAllMocks();
  vi.mocked(tasksModule.findTaskFilePath).mockReturnValue("/some/path.json");
  vi.mocked(tasksModule.readTaskFile).mockReturnValue(makeTask());
  vi.mocked(filesModule.saveFile).mockReturnValue(undefined);
  vi.mocked(commentsModule.addComment).mockReturnValue(undefined);
  mockPage.goto.mockResolvedValue(undefined);
  mockPage.waitForSelector.mockResolvedValue(undefined);
  mockLocatorObj.count.mockResolvedValue(1);
  mockElement.evaluate.mockResolvedValue("<div>test</div>");
  mockElement.boundingBox.mockResolvedValue({
    x: 100,
    y: 200,
    width: 120,
    height: 40,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("verifyTask — error paths (§9.4)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempProject();
    resetMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws E_NOT_FOUND when task does not exist", async () => {
    vi.mocked(tasksModule.findTaskFilePath).mockReturnValue(null);

    await expect(verifyTask(tempDir, "nonexistent")).rejects.toMatchObject({
      code: "E_NOT_FOUND",
      message: expect.stringContaining("Task not found"),
    });
  });

  it("throws E_NOT_FOUND when readTaskFile returns null", async () => {
    vi.mocked(tasksModule.readTaskFile).mockReturnValue(null);

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_NOT_FOUND",
    });
  });

  it("throws E_NO_BASELINE when task has no baseline", async () => {
    vi.mocked(tasksModule.readTaskFile).mockReturnValue(
      makeTask({ baseline: undefined }),
    );

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_NO_BASELINE",
      message: expect.stringContaining("no baseline"),
    });
  });

  it("throws E_AUTH_EXPIRED when auth state is expired", async () => {
    vi.mocked(tasksModule.readTaskFile).mockReturnValue(
      makeTask({
        author: "alice",
        authStateEnc: JSON.stringify({
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:00:00.000Z",
          iv: "00000000000000000000000000000000",
          tag: "00000000000000000000000000000000",
          data: "0000000000000000",
        }),
      }),
    );

    const authModule = await import("../../../src/core/auth.js");
    vi.spyOn(authModule, "decryptAuthState").mockReturnValue(null);

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_AUTH_EXPIRED",
    });
  });

  it("throws E_AUTH_CORRUPT when auth state decryption throws", async () => {
    vi.mocked(tasksModule.readTaskFile).mockReturnValue(
      makeTask({
        author: "alice",
        authStateEnc: JSON.stringify({
          version: 1,
          createdAt: "2026-08-28T22:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          iv: "00000000000000000000000000000000",
          tag: "00000000000000000000000000000000",
          data: "invalid",
        }),
      }),
    );

    const authModule = await import("../../../src/core/auth.js");
    vi.spyOn(authModule, "decryptAuthState").mockImplementation(() => {
      throw new Error("decryption failed");
    });

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_AUTH_CORRUPT",
    });
  });

  it("throws E_NO_URL when task has no URL and no --url override", async () => {
    vi.mocked(tasksModule.readTaskFile).mockReturnValue(
      makeTask({ url: undefined }),
    );

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_NO_URL",
      message: expect.stringContaining("no URL"),
    });
  });

  it("throws E_NO_SELECTOR when task selector is '/'", async () => {
    vi.mocked(tasksModule.readTaskFile).mockReturnValue(
      makeTask({ selector: "/", cssSelector: undefined }),
    );

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_NO_SELECTOR",
    });
  });

  it("throws E_NO_SELECTOR when task has empty selector", async () => {
    vi.mocked(tasksModule.readTaskFile).mockReturnValue(
      makeTask({ selector: "", cssSelector: undefined }),
    );

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_NO_SELECTOR",
    });
  });

  it("throws E_PLAYWRIGHT_CRASH when browser launch fails", async () => {
    const pw = await import("playwright");
    vi.mocked(pw.chromium.launch).mockRejectedValue(
      new Error("Browser crashed"),
    );

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_PLAYWRIGHT_CRASH",
    });

    vi.mocked(pw.chromium.launch).mockResolvedValue(mockBrowser);
  });

  it("throws E_PLAYWRIGHT_MISSING when launch error mentions 'not installed'", async () => {
    const pw = await import("playwright");
    vi.mocked(pw.chromium.launch).mockRejectedValue(
      new Error("Executable doesn't exist"),
    );

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_PLAYWRIGHT_MISSING",
    });

    vi.mocked(pw.chromium.launch).mockResolvedValue(mockBrowser);
  });

  it("throws E_APP_NOT_RUNNING when page.goto throws ECONNREFUSED", async () => {
    mockPage.goto.mockRejectedValue(
      new Error("net::ERR_CONNECTION_REFUSED at http://localhost:5173"),
    );

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_APP_NOT_RUNNING",
    });
  });

  it("throws E_NAVIGATION_FAILED when page.goto throws generic error", async () => {
    mockPage.goto.mockRejectedValue(new Error("Navigation timeout"));

    await expect(verifyTask(tempDir, "test-task-123")).rejects.toMatchObject({
      code: "E_NAVIGATION_FAILED",
    });
  });
});

describe("verifyTask — happy paths", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempProject();
    resetMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("verifies successfully with auth state", async () => {
    vi.mocked(tasksModule.readTaskFile).mockReturnValue(
      makeTask({
        author: "alice",
        authStateEnc: JSON.stringify({
          version: 1,
          createdAt: "2026-08-28T22:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          iv: "00000000000000000000000000000000",
          tag: "00000000000000000000000000000000",
          data: "0000000000000000",
        }),
      }),
    );

    const authModule = await import("../../../src/core/auth.js");
    vi.spyOn(authModule, "decryptAuthState").mockReturnValue({
      cookies: [
        {
          name: "session",
          value: "abc",
          domain: "localhost",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      localStorage: { token: "jwt" },
      sessionStorage: {},
    });

    const result = await verifyTask(tempDir, "test-task-123");

    expect(result.taskId).toBe("test-task-123");
    expect(result.ok).toBe(true);
    expect(result.taskDescription).toBe("Fix submit button color to blue");
    expect(result.baseline).toBeDefined();
    expect(result.after).toBeDefined();
    expect(result.diff).toBeDefined();
    expect(result.evidenceFiles).toBeDefined();
    expect(result.verdict).toBeDefined();
  });

  it("verifies successfully without auth state", async () => {
    vi.mocked(tasksModule.readTaskFile).mockReturnValue(
      makeTask({ author: undefined, authStateEnc: undefined }),
    );

    const result = await verifyTask(tempDir, "test-task-123");

    expect(result.ok).toBe(true);
    expect(result.taskId).toBe("test-task-123");
  });

  it("uses --url override when provided", async () => {
    vi.mocked(tasksModule.readTaskFile).mockReturnValue(
      makeTask({ url: "http://localhost:5173/original" }),
    );

    const result = await verifyTask(tempDir, "test-task-123", {
      url: "http://localhost:3001/override",
    });

    expect(result.ok).toBe(true);
    expect(mockPage.goto).toHaveBeenCalledWith(
      "http://localhost:3001/override",
      expect.any(Object),
    );
  });

  it("returns selectorResolves: false when element not found", async () => {
    mockPage.waitForSelector.mockRejectedValue(
      new Error("Timeout 10000ms exceeded"),
    );

    const result = await verifyTask(tempDir, "test-task-123");

    expect(result.ok).toBe(false);
    expect(result.diff.selectorResolves).toBe(false);
    expect(result.verdict).toContain("no longer resolves");
  });

  it("returns verdict with element count when multiple elements match", async () => {
    mockLocatorObj.count.mockResolvedValue(3);

    const result = await verifyTask(tempDir, "test-task-123");

    expect(result.ok).toBe(false);
    expect(result.verdict).toContain("3 elements");
  });
});

describe("verifyTask — result shape (§9.3)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempProject();
    resetMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns all required fields in result shape", async () => {
    const result = await verifyTask(tempDir, "test-task-123");

    expect(result).toHaveProperty("taskId");
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("taskDescription");
    expect(result).toHaveProperty("baseline");
    expect(result).toHaveProperty("after");
    expect(result).toHaveProperty("diff");
    expect(result).toHaveProperty("evidenceFiles");
    expect(result).toHaveProperty("verdict");

    expect(result.baseline).toHaveProperty("selector");
    expect(result.baseline).toHaveProperty("url");
    expect(result.baseline).toHaveProperty("capturedAt");
    expect(result.baseline).toHaveProperty("snapshot");

    expect(result.after).toHaveProperty("snapshot");
    expect(result.after).toHaveProperty("consoleErrors");

    expect(result.diff).toHaveProperty("selectorResolves");
    expect(result.diff).toHaveProperty("htmlChanged");
    expect(result.diff).toHaveProperty("stylesChanged");
    expect(result.diff).toHaveProperty("positionChanged");
    expect(result.diff).toHaveProperty("newConsoleErrors");
  });

  it("sets ok=true when selector resolves and no new console errors", async () => {
    const result = await verifyTask(tempDir, "test-task-123");

    expect(result.ok).toBe(true);
    expect(result.diff.selectorResolves).toBe(true);
    expect(result.diff.newConsoleErrors).toHaveLength(0);
  });

  it("sets ok=false when selector does not resolve", async () => {
    mockPage.waitForSelector.mockRejectedValue(new Error("Timeout"));

    const result = await verifyTask(tempDir, "test-task-123");

    expect(result.ok).toBe(false);
    expect(result.diff.selectorResolves).toBe(false);
  });
});

describe("verifyTask — system comments", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempProject();
    resetMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes system comment on successful verification", async () => {
    await runVerify(tempDir, "test-task-123", { json: false });

    expect(commentsModule.addComment).toHaveBeenCalledWith(
      expect.any(String),
      "test-task-123",
      "agent",
      expect.stringContaining("✅ passed"),
      undefined,
      "system",
    );
  });

  it("writes system comment with 'issues detected' when verification has issues", async () => {
    mockPage.waitForSelector.mockRejectedValue(new Error("Timeout"));

    await runVerify(tempDir, "test-task-123", { json: false });

    expect(commentsModule.addComment).toHaveBeenCalledWith(
      expect.any(String),
      "test-task-123",
      "agent",
      expect.stringContaining("⚠️ issues detected"),
      undefined,
      "system",
    );
  });
});

describe("runVerify — CLI entry point", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempProject();
    resetMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("outputs JSON when --json flag is set", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerify(tempDir, "test-task-123", { json: true });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.taskId).toBe("test-task-123");
    expect(output.ok).toBe(true);

    consoleSpy.mockRestore();
  });

  it("sets process.exitCode on VerifyError", async () => {
    vi.mocked(tasksModule.findTaskFilePath).mockReturnValue(null);

    const originalExitCode = process.exitCode;
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await runVerify(tempDir, "nonexistent", {});

    expect(process.exitCode).toBe(1);

    process.exitCode = originalExitCode;
    stderrSpy.mockRestore();
  });

  it("outputs JSON error to stderr when --json and error occurs", async () => {
    vi.mocked(tasksModule.findTaskFilePath).mockReturnValue(null);

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await runVerify(tempDir, "nonexistent", { json: true });

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(stderrSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe("E_NOT_FOUND");

    stderrSpy.mockRestore();
  });
});

describe("verifyTask — evidence storage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempProject();
    resetMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores evidence files", async () => {
    const result = await verifyTask(tempDir, "test-task-123");

    // At least 3 core evidence files, plus optional Playwright artifacts
    expect(result.evidenceFiles.length).toBeGreaterThanOrEqual(3);
    expect(
      result.evidenceFiles.some((f) => f.includes("verify-after.json")),
    ).toBe(true);
    expect(
      result.evidenceFiles.some((f) => f.includes("verify-diff.json")),
    ).toBe(true);
    expect(
      result.evidenceFiles.some((f) => f.includes("verify-console.txt")),
    ).toBe(true);

    // Playwright artifacts may or may not be present depending on mock setup
    // (verify-page.html, verify-screenshot.png, verify-element.html)

    expect(filesModule.saveFile).toHaveBeenCalled();
  });
});
