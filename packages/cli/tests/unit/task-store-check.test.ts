/**
 * Store-integrity checker (ticket 8538344b): a temp dir with one
 * conflict-marker file fails naming the path, a clean dir passes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkTaskStore,
  checkTaskStoreText,
  formatTaskStoreOffenders,
} from "../../src/core/task-store-check.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function store(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "store-check-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, ".vibeflow", "tasks", "2026-01-01");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf-8");
  }
  return base;
}

const CLEAN = JSON.stringify({
  id: "abc",
  title: "Clean",
  status: "todo",
  created: "2026-01-01T00:00:00.000Z",
  comments: [],
  files: [],
});

describe("checkTaskStoreText", () => {
  it("passes valid JSON", () => {
    expect(checkTaskStoreText(CLEAN)).toBeNull();
  });

  it("fails a conflict-marker file", () => {
    const reason = checkTaskStoreText(
      `{\n<<<<<<< HEAD\n${CLEAN}\n=======\n${CLEAN}\n>>>>>>> branch\n}`,
    );
    expect(reason).toContain("conflict marker");
  });

  it("fails truncated JSON without markers", () => {
    const reason = checkTaskStoreText(`{"id": "abc", "title": `);
    expect(reason).toContain("invalid JSON");
  });

  it("ignores a marker mid-line (data, not a conflict)", () => {
    const withData = JSON.stringify({
      id: "abc",
      title: "a >>>>>>> b",
      description: "x ======= y",
      status: "todo",
    });
    expect(checkTaskStoreText(withData)).toBeNull();
  });
});

describe("checkTaskStore", () => {
  it("a temp dir with one conflict-marker file fails naming the path", () => {
    const base = store({
      "clean.json": CLEAN,
      "conflicted.json": `{\n<<<<<<< HEAD\n"id": "bad"\n=======\n"id": "worse"\n>>>>>>> branch\n}`,
    });
    const result = checkTaskStore(base);
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(2);
    expect(result.offenders).toHaveLength(1);
    expect(result.offenders[0]?.filePath).toContain("conflicted.json");
    expect(result.offenders[0]?.reason).toContain("conflict marker");
    expect(formatTaskStoreOffenders(result).join("\n")).toContain("conflicted.json");
  });

  it("a clean dir passes", () => {
    const base = store({ "clean.json": CLEAN });
    const result = checkTaskStore(base);
    expect(result).toEqual({ ok: true, checked: 1, offenders: [] });
  });

  it("a missing store is not an offense", () => {
    const base = mkdtempSync(join(tmpdir(), "store-check-empty-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    expect(checkTaskStore(base)).toEqual({ ok: true, checked: 0, offenders: [] });
  });

  it("ignores auth sidecars", () => {
    const base = store({ "clean.json": CLEAN, "x.auth.json": "not json {{{" });
    expect(checkTaskStore(base).ok).toBe(true);
  });
});
