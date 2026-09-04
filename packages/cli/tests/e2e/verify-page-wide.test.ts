/**
 * verify page-wide (e2e) — ORPHANED, SKIPPED.
 *
 * This spec has never been loadable: it uses CJS `__dirname` (throws at
 * collection in ESM) and its beforeAll runs `execSync` on the never-exiting
 * `kanban` server on a hardcoded port (3750–3790 e2e exclusion range).
 * Making it pass requires a verify-with-browser harness (random port, task
 * with url+selector, evidence assertions) — tracked as a follow-up task.
 * Skipped so the e2e suite can be honestly green; do not unskip without
 * implementing the harness.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "index.js");
const TASK_ID = "e2e-page-wide-test";
const PROJECT = "/tmp/vibeflow-e2e-page-wide";
const FILES_DIR = join(PROJECT, ".vibeflow/tasks/files", TASK_ID);

// pi-lens-ignore: no-sql-injection -- execSync runs CLI commands, not SQL queries
function run(cmd: string): string {
  return execSync(cmd, { cwd: PROJECT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

describe.skip("verify page-wide (e2e) — orphaned, needs verify+browser harness", () => {
  beforeAll(() => {
    rmSync(PROJECT, { recursive: true, force: true });
    run(`node ${CLI} kanban --port 3778 --no-open`);
  });

  afterAll(() => {
    run("kill $(lsof -ti:3778) 2>/dev/null || true");
  });

  it("captures page-wide snapshot on verify", () => {
    // Create a task
    run(`node ${CLI} tasks --add --title "E2E test" --description "test"`);

    // Run verify
    run(`node ${CLI} verify ${TASK_ID}`);

    // Check that page-wide evidence files exist
    expect(existsSync(join(FILES_DIR, "verify-all-styles.json"))).toBe(true);

    const allStyles = JSON.parse(readFileSync(join(FILES_DIR, "verify-all-styles.json"), "utf-8"));
    expect(allStyles.version).toBe(1);
    expect(allStyles.elements).toBeDefined();
    expect(Object.keys(allStyles.elements).length).toBeGreaterThan(0);
  });

  it("style_diff returns summary", () => {
    const result = run(`node ${CLI} verify style_diff ${TASK_ID}`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.total).toBeGreaterThanOrEqual(0);
    expect(parsed.elementCount).toBeGreaterThanOrEqual(0);
  });

  it("style_query filters by property", () => {
    const result = run(`node ${CLI} verify style_query ${TASK_ID} color`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.prop).toBe("color");
    expect(Array.isArray(parsed.matches)).toBe(true);
  });

  it("html_query children returns changes", () => {
    const result = run(`node ${CLI} verify html_query ${TASK_ID} children`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.queryType).toBe("children");
    expect(Array.isArray(parsed.matches)).toBe(true);
  });

  it("html_query text returns changes", () => {
    const result = run(`node ${CLI} verify html_query ${TASK_ID} text`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.queryType).toBe("text");
    expect(Array.isArray(parsed.matches)).toBe(true);
  });

  it("element_info returns element details", () => {
    const result = run(`node ${CLI} verify element_info ${TASK_ID}`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.selector).toBeDefined();
  });
});
