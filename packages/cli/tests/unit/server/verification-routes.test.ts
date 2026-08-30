import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { createServer, type Server } from "node:http";
import { ensureTaskDirs, createTask, findTaskFilePath } from "../../../src/core/tasks.js";
import { saveFile } from "../../../src/core/files.js";
import { encryptAuthState } from "../../../src/core/auth.js";
import { PROTO_DIR } from "../../../src/core/types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AuthState, DomSnapshot } from "../../../src/core/verification-types.js";
import { writeConfig } from "../../../src/core/config.js";

// ── Setup ─────────────────────────────────────────────────────────────────

function makeBaseline(): DomSnapshot {
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

function makeAuthState(): AuthState {
  return {
    cookies: [
      { name: "session", value: "abc123", domain: "localhost", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
    ],
    localStorage: { token: "jwt-secret" },
    sessionStorage: {},
  };
}

function createTestApp(projectDir: string): Server {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // POST /api/tasks/:id/auth-state
  app.post("/api/tasks/:id/auth-state", express.json(), async (req, res) => {
    const { id } = req.params;
    const { authState, taskAuthor } = req.body as {
      authState?: AuthState;
      taskAuthor?: string;
    };

    if (!findTaskFilePath(projectDir, id)) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (!authState || !taskAuthor) {
      res.status(400).json({ error: "Missing required fields: authState, taskAuthor" });
      return;
    }

    try {
      const encrypted = encryptAuthState(authState, taskAuthor);
      const authStatePath = join(projectDir, PROTO_DIR, `auth-state.${id}.enc`);
      mkdirSync(join(projectDir, PROTO_DIR), { recursive: true });
      writeFileSync(authStatePath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to store auth state" });
    }
  });

  // POST /api/tasks/:id/baseline
  app.post("/api/tasks/:id/baseline", express.json(), (req, res) => {
    const { id } = req.params;
    const { baseline } = req.body as { baseline?: DomSnapshot };

    if (!findTaskFilePath(projectDir, id)) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    if (!baseline || !baseline.selector || !baseline.outerHTML) {
      res.status(400).json({ error: "Missing required fields: baseline.selector, baseline.outerHTML" });
      return;
    }

    try {
      const baselineJson = JSON.stringify(baseline, null, 2);
      saveFile(projectDir, id, "baseline.json", Buffer.from(baselineJson));
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: "Failed to store baseline" });
    }
  });

  return createServer(app);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/tasks/:id/auth-state", () => {
  let tempDir: string;
  let server: Server;
  let port: number;
  let taskId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "verification-routes-"));
    ensureTaskDirs(tempDir);
    writeConfig(tempDir, { mode: "attach", port: 3700 });

    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: ".submit",
    });
    taskId = task.id;

    server = createTestApp(tempDir);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores auth state successfully", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/${taskId}/auth-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authState: makeAuthState(), taskAuthor: "alice" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const authPath = join(tempDir, ".vibeflow", `auth-state.${taskId}.enc`);
    expect(existsSync(authPath)).toBe(true);
  });

  it("returns 404 for nonexistent task", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/nonexistent0000000000000000/auth-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authState: makeAuthState(), taskAuthor: "alice" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when authState is missing", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/${taskId}/auth-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskAuthor: "alice" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when taskAuthor is missing", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/${taskId}/auth-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authState: makeAuthState() }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/tasks/:id/baseline", () => {
  let tempDir: string;
  let server: Server;
  let port: number;
  let taskId: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "verification-routes-"));
    ensureTaskDirs(tempDir);
    writeConfig(tempDir, { mode: "attach", port: 3700 });

    const task = createTask(tempDir, {
      title: "Test task",
      description: "",
      status: "in-progress",
      selector: ".submit",
    });
    taskId = task.id;

    server = createTestApp(tempDir);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores baseline successfully", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/${taskId}/baseline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseline: makeBaseline() }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const baselinePath = join(tempDir, ".vibeflow", "tasks", "files", taskId, "baseline.json");
    expect(existsSync(baselinePath)).toBe(true);
  });

  it("returns 404 for nonexistent task", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/nonexistent0000000000000000/baseline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseline: makeBaseline() }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when baseline is missing", async () => {
    const res = await fetch(`http://localhost:${port}/api/tasks/${taskId}/baseline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when baseline.selector is missing", async () => {
    const baseline = { ...makeBaseline(), selector: "" };
    const res = await fetch(`http://localhost:${port}/api/tasks/${taskId}/baseline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseline }),
    });
    expect(res.status).toBe(400);
  });
});
