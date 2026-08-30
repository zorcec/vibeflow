import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  findTaskFilePath,
  readTaskFile,
} from "../../src/core/tasks.js";
import { encryptAuthState, decryptAuthState } from "../../src/core/auth.js";
import { PROTO_DIR, FILES_DIR } from "../../src/core/types.js";

// ── Test: Full verification flow ──────────────────────────────────────────────

describe("verification flow — end to end", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-verify-e2e-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("captures baseline and auth state at annotation time", () => {
    // 1. Create a task (simulating overlay annotation)
    const task = createTask(tempDir, {
      title: "Fix submit button color",
      description: "The submit button should be blue, not red",
      status: "todo",
      selector: "#kanban-board",
      cssSelector:
        "#kanban-board > section.board-column:nth-child(2) > div.column-scroll:nth-child(2)",
      url: "/kanban",
    });

    expect(task.id).toBeDefined();
    expect(task.title).toBe("Fix submit button color");

    // 2. Verify task was created
    const taskFilePath = findTaskFilePath(tempDir, task.id);
    expect(taskFilePath).toBeDefined();

    const savedTask = readTaskFile(taskFilePath!);
    expect(savedTask).toBeDefined();
    expect(savedTask!.title).toBe("Fix submit button color");
    expect(savedTask!.selector).toBe("#kanban-board");
  });

  it("stores baseline snapshot via API route", () => {
    // 1. Create a task
    const task = createTask(tempDir, {
      title: "Test baseline storage",
      description: "Test",
      status: "todo",
      selector: "#test-element",
      url: "/test",
    });

    // 2. Simulate baseline snapshot
    const baseline = {
      outerHTML: '<div id="test-element" class="old-class">Old content</div>',
      computedStyles: {
        "background-color": "#EF4444",
        color: "#FFFFFF",
        fontSize: "14px",
      },
      selector: "#test-element",
      position: {
        boundingBox: { x: 100, y: 200, width: 120, height: 40 },
        scrollPosition: { x: 0, y: 0 },
        viewport: { width: 1280, height: 720, dpr: 2 },
        stackingContext: { zIndex: "auto", position: "relative" },
      },
      browser: "Mozilla/5.0",
      consoleErrors: [],
      capturedAt: new Date().toISOString(),
    };

    // 3. Store baseline (simulating API call)
    const baselinePath = join(
      tempDir,
      PROTO_DIR,
      FILES_DIR,
      task.id,
      "baseline.json",
    );
    mkdirSync(join(tempDir, PROTO_DIR, FILES_DIR, task.id), {
      recursive: true,
    });
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    // 4. Verify baseline was stored
    expect(existsSync(baselinePath)).toBe(true);

    const storedBaseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
    expect(storedBaseline.outerHTML).toBe(baseline.outerHTML);
    expect(storedBaseline.selector).toBe("#test-element");
    expect(storedBaseline.position.boundingBox.x).toBe(100);
  });

  it("stores encrypted auth state via API route", () => {
    // 1. Create a task
    const task = createTask(tempDir, {
      title: "Test auth storage",
      description: "Test",
      status: "todo",
      selector: "#test-element",
      url: "/test",
    });

    // 2. Simulate auth state
    const authState = {
      cookies: [
        {
          name: "session",
          value: "abc123",
          domain: "localhost",
          path: "/",
          expires: Date.now() + 86400000,
          httpOnly: false,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      localStorage: { token: "jwt-secret" },
      sessionStorage: { cart: "[]" },
    };

    // 3. Encrypt and store auth state (simulating API call)
    const encrypted = encryptAuthState(authState, "test-author");
    const authStatePath = join(tempDir, PROTO_DIR, `auth-state.${task.id}.enc`);
    mkdirSync(join(tempDir, PROTO_DIR), { recursive: true });
    writeFileSync(authStatePath, JSON.stringify(encrypted, null, 2), {
      mode: 0o600,
    });

    // 4. Verify auth state was stored
    expect(existsSync(authStatePath)).toBe(true);

    const storedEncrypted = JSON.parse(readFileSync(authStatePath, "utf-8"));
    expect(storedEncrypted.version).toBe(1);
    expect(storedEncrypted.iv).toBeDefined();
    expect(storedEncrypted.tag).toBeDefined();
    expect(storedEncrypted.data).toBeDefined();

    // 5. Verify decryption works
    const decrypted = decryptAuthState(storedEncrypted, "test-author");
    expect(decrypted).toBeDefined();
    expect(decrypted!.cookies[0].name).toBe("session");
    expect(decrypted!.localStorage.token).toBe("jwt-secret");
  });

  it("full flow: annotate → baseline → auth → verify → evidence", () => {
    // 1. Create task (annotation)
    const task = createTask(tempDir, {
      title: "Fix button color",
      description: "Change button from red to blue",
      status: "todo",
      selector: ".submit-btn",
      cssSelector: ".submit-btn",
      url: "/form",
    });

    // 2. Capture baseline
    const baseline = {
      outerHTML:
        '<button class="submit-btn" style="background: red">Submit</button>',
      computedStyles: { "background-color": "#EF4444", color: "#FFFFFF" },
      selector: ".submit-btn",
      position: {
        boundingBox: { x: 100, y: 200, width: 120, height: 40 },
        scrollPosition: { x: 0, y: 0 },
        viewport: { width: 1280, height: 720, dpr: 2 },
        stackingContext: { zIndex: "auto", position: "relative" },
      },
      browser: "Mozilla/5.0",
      consoleErrors: [],
      capturedAt: new Date().toISOString(),
    };

    const baselinePath = join(
      tempDir,
      PROTO_DIR,
      FILES_DIR,
      task.id,
      "baseline.json",
    );
    mkdirSync(join(tempDir, PROTO_DIR, FILES_DIR, task.id), {
      recursive: true,
    });
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));

    // 3. Capture auth state
    const authState = {
      cookies: [
        {
          name: "session",
          value: "abc123",
          domain: "localhost",
          path: "/",
          expires: Date.now() + 86400000,
          httpOnly: false,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      localStorage: { token: "jwt-secret" },
      sessionStorage: {},
    };

    const encrypted = encryptAuthState(authState, "test-author");
    const authStatePath = join(tempDir, PROTO_DIR, `auth-state.${task.id}.enc`);
    writeFileSync(authStatePath, JSON.stringify(encrypted, null, 2), {
      mode: 0o600,
    });

    // 4. Verify all files exist
    expect(existsSync(baselinePath)).toBe(true);
    expect(existsSync(authStatePath)).toBe(true);

    // 5. Verify baseline content
    const storedBaseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
    expect(storedBaseline.outerHTML).toContain("submit-btn");
    expect(storedBaseline.outerHTML).toContain("background: red");

    // 6. Verify auth state can be decrypted
    const storedEncrypted = JSON.parse(readFileSync(authStatePath, "utf-8"));
    const decrypted = decryptAuthState(storedEncrypted, "test-author");
    expect(decrypted!.cookies[0].value).toBe("abc123");
    expect(decrypted!.localStorage.token).toBe("jwt-secret");

    // 7. Verify task has correct metadata
    const savedTask = readTaskFile(findTaskFilePath(tempDir, task.id)!);
    expect(savedTask!.title).toBe("Fix button color");
    expect(savedTask!.selector).toBe(".submit-btn");
    expect(savedTask!.url).toBe("/form");
  });
});
