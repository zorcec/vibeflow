import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const FRAMEWORK_POC_HTML = readFileSync(
  join(__dirname, "../fixtures/framework-poc.html"),
  "utf-8",
);

describe("selector priority (e2e)", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;
  const PORT = 3790;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-e2e-selectors-"));
    writeFileSync(join(tempDir, "index.html"), FRAMEWORK_POC_HTML, "utf-8");
    mkdirSync(join(tempDir, ".vibeflow", "tasks"), { recursive: true });
    mkdirSync(join(tempDir, ".vibeflow", "screenshots"), { recursive: true });
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createTask(data: Record<string, unknown>) {
    const res = await fetch(`http://localhost:${PORT}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.json();
  }

  async function getTasks() {
    const res = await fetch(`http://localhost:${PORT}/api/tasks`);
    return res.json();
  }

  it("stores file:line as selector when source file is available", async () => {
    instance = await serve(tempDir, { port: PORT, open: false });
    const result = await createTask({
      title: "Fix dashboard layout",
      description: "Layout broken on mobile",
      selector: "/src/components/Dashboard.tsx:42",
      cssSelector: "#react17-element",
      file: "/src/components/Dashboard.tsx",
      line: 42,
      col: 8,
      component: "Dashboard",
    });
    expect(result.success).toBe(true);
    expect(result.task.selector).toBe("/src/components/Dashboard.tsx:42");
    expect(result.task.cssSelector).toBe("#react17-element");
    expect(result.task.file).toBe("/src/components/Dashboard.tsx");
    expect(result.task.component).toBe("Dashboard");
  });

  it("stores component name as selector when only component available", async () => {
    instance = await serve(tempDir, { port: PORT, open: false });
    const result = await createTask({
      title: "Fix profile card",
      description: "Style issue",
      selector: "ProfileCard",
      cssSelector: "#react18-element",
      component: "ProfileCard",
    });
    expect(result.success).toBe(true);
    expect(result.task.selector).toBe("ProfileCard");
    expect(result.task.component).toBe("ProfileCard");
  });

  it("stores test-id selector when no framework source", async () => {
    instance = await serve(tempDir, { port: PORT, open: false });
    const result = await createTask({
      title: "Fix submit button",
      description: "Not clickable",
      selector: '[data-testid="submit-button"]',
      cssSelector: '[data-testid="submit-button"]',
    });
    expect(result.success).toBe(true);
    expect(result.task.selector).toBe('[data-testid="submit-button"]');
  });

  it("stores CSS selector as fallback when nothing else available", async () => {
    instance = await serve(tempDir, { port: PORT, open: false });
    const result = await createTask({
      title: "Fix layout",
      description: "Alignment issue",
      selector: "#fallback-section > div.element.fallback-target",
      cssSelector: "#fallback-section > div.element.fallback-target",
    });
    expect(result.success).toBe(true);
    expect(result.task.selector).toBe(
      "#fallback-section > div.element.fallback-target",
    );
  });

  it("retrieves tasks with all source fields preserved", async () => {
    instance = await serve(tempDir, { port: PORT, open: false });
    await createTask({
      title: "React 17 task",
      selector: "/src/App.tsx:10",
      cssSelector: "#react17-element",
      file: "/src/App.tsx",
      line: 10,
      col: 5,
      component: "App",
    });
    await createTask({
      title: "React 18 task",
      selector: "ProfileCard",
      cssSelector: "#react18-element",
      component: "ProfileCard",
    });
    await createTask({
      title: "Vanilla task",
      selector: '[data-testid="submit-button"]',
      cssSelector: '[data-testid="submit-button"]',
    });

    const data = await getTasks();
    expect(data.tasks.length).toBe(3);

    const react17Task = data.tasks.find(
      (t: Record<string, unknown>) => t.title === "React 17 task",
    );
    expect(react17Task.selector).toBe("/src/App.tsx:10");
    expect(react17Task.file).toBe("/src/App.tsx");
    expect(react17Task.line).toBe(10);
    expect(react17Task.component).toBe("App");

    const react18Task = data.tasks.find(
      (t: Record<string, unknown>) => t.title === "React 18 task",
    );
    expect(react18Task.selector).toBe("ProfileCard");
    expect(react18Task.component).toBe("ProfileCard");

    const vanillaTask = data.tasks.find(
      (t: Record<string, unknown>) => t.title === "Vanilla task",
    );
    expect(vanillaTask.selector).toBe('[data-testid="submit-button"]');
  });
});
