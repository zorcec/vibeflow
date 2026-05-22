import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateFile, validateDirectory, isDirectory } from "../../src/commands/validate.js";

describe("validateFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-validate-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes for valid HTML with proto-ids", () => {
    const html = `<!DOCTYPE html><html><body>
<div data-vibeflow-id="hero">Hero</div>
<button data-vibeflow-id="cta">Click</button>
</body></html>`;

    const filePath = join(tempDir, "valid.html");
    writeFileSync(filePath, html, "utf-8");

    const result = validateFile(filePath);
    expect(result.valid).toBe(true);
    expect(result.stats.elementsWithIds).toBe(2);
  });

  it("detects missing IDs when compared to previous version", () => {
    const previousHtml = `<div data-vibeflow-id="hero">Hero</div>
<div data-vibeflow-id="sidebar">Side</div>
<div data-vibeflow-id="footer">Foot</div>`;

    const currentHtml = `<div data-vibeflow-id="hero">Hero Updated</div>`;

    const prevPath = join(tempDir, "previous.html");
    const currPath = join(tempDir, "current.html");
    writeFileSync(prevPath, previousHtml, "utf-8");
    writeFileSync(currPath, currentHtml, "utf-8");

    const result = validateFile(currPath, prevPath);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("detects duplicate proto-ids", () => {
    const html = `<div data-vibeflow-id="dup">A</div>
<div data-vibeflow-id="dup">B</div>`;

    const filePath = join(tempDir, "dups.html");
    writeFileSync(filePath, html, "utf-8");

    const result = validateFile(filePath);
    expect(result.valid).toBe(false);
  });

  it("passes when all previous IDs preserved", () => {
    const previousHtml = `<div data-vibeflow-id="a">A</div>
<div data-vibeflow-id="b">B</div>`;

    const currentHtml = `<div data-vibeflow-id="a">A Updated</div>
<div data-vibeflow-id="b">B Updated</div>
<div data-vibeflow-id="c">C New</div>`;

    const prevPath = join(tempDir, "prev.html");
    const currPath = join(tempDir, "curr.html");
    writeFileSync(prevPath, previousHtml, "utf-8");
    writeFileSync(currPath, currentHtml, "utf-8");

    const result = validateFile(currPath, prevPath);
    expect(result.valid).toBe(true);
  });

  it("generates warning when no data-vibeflow-id attributes found", () => {
    const html = `<!DOCTYPE html><html><body><div>No IDs here</div></body></html>`;
    const filePath = join(tempDir, "no-ids.html");
    writeFileSync(filePath, html, "utf-8");

    const result = validateFile(filePath);
    expect(result.valid).toBe(true);
    const warnings = result.issues.filter((i) => i.type === "warning");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].message).toContain("No data-vibeflow-id");
  });

  it("generates warning for non-CDN external dependencies", () => {
    const html = `<!DOCTYPE html><html><head><script src="https://evil-cdn.com/bad.js"></script></head><body><div data-vibeflow-id="x">X</div></body></html>`;
    const filePath = join(tempDir, "external.html");
    writeFileSync(filePath, html, "utf-8");

    const result = validateFile(filePath);
    const warnings = result.issues.filter((i) => i.type === "warning");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].message).toContain("Non-CDN external dependency");
  });
});

describe("validateDirectory", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-validate-dir-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const makeHtml = (id: string) =>
    `<!DOCTYPE html><html><body><div data-vibeflow-id="${id}">Test</div></body></html>`;

  it("passes for a directory with unique IDs across files", () => {
    writeFileSync(join(tempDir, "page1.html"), makeHtml("unique-a"), "utf-8");
    writeFileSync(join(tempDir, "page2.html"), makeHtml("unique-b"), "utf-8");

    const result = validateDirectory(tempDir);
    expect(result.valid).toBe(true);
    expect(Object.keys(result.fileResults)).toHaveLength(2);
  });

  it("detects cross-file duplicate IDs", () => {
    writeFileSync(join(tempDir, "page1.html"), makeHtml("dup-id"), "utf-8");
    writeFileSync(join(tempDir, "page2.html"), makeHtml("dup-id"), "utf-8");

    const result = validateDirectory(tempDir);
    expect(result.crossFileIssues.length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });

  it("throws for empty directory", () => {
    expect(() => validateDirectory(tempDir)).toThrow("No HTML files");
  });

  it("fails validation when a file has issues (issues branch covered)", () => {
    // Create a file with duplicate IDs so result.valid is false and issues are printed
    const html = `<div data-vibeflow-id="dup">A</div><div data-vibeflow-id="dup">B</div>`;
    writeFileSync(join(tempDir, "bad.html"), html, "utf-8");
    const result = validateDirectory(tempDir);
    expect(result.valid).toBe(false);
    // At least one file result must have issues
    const withIssues = Object.values(result.fileResults).filter((r) => r.issues.length > 0);
    expect(withIssues.length).toBeGreaterThan(0);
  });

  it("reports filesWithWarnings when valid file has warnings", () => {
    // HTML with no data-vibeflow-id generates a warning but is still valid
    const html = `<!DOCTYPE html><html><body><div>No IDs here</div></body></html>`;
    writeFileSync(join(tempDir, "no-ids.html"), html, "utf-8");

    const result = validateDirectory(tempDir);
    expect(result.valid).toBe(true);
    expect(result.stats.filesWithWarnings).toBe(1);
    expect(result.stats.filesWithErrors).toBe(0);
  });

  it("reports filesWithErrors when file has duplicate IDs", () => {
    const html = `<div data-vibeflow-id="dup">A</div><div data-vibeflow-id="dup">B</div>`;
    writeFileSync(join(tempDir, "errors.html"), html, "utf-8");

    const result = validateDirectory(tempDir);
    expect(result.valid).toBe(false);
    // 1 file with errors + 1 for cross-file duplicate (same file listed twice)
    expect(result.stats.filesWithErrors).toBe(2);
  });

  it("reports both filesWithErrors and filesWithWarnings together", () => {
    const badHtml = `<div data-vibeflow-id="dup">A</div><div data-vibeflow-id="dup">B</div>`;
    const warnHtml = `<!DOCTYPE html><html><body><div>No IDs</div></body></html>`;
    writeFileSync(join(tempDir, "bad.html"), badHtml, "utf-8");
    writeFileSync(join(tempDir, "warn.html"), warnHtml, "utf-8");

    const result = validateDirectory(tempDir);
    expect(result.valid).toBe(false);
    // 1 file with errors + 1 for cross-file duplicate
    expect(result.stats.filesWithErrors).toBe(2);
    expect(result.stats.filesWithWarnings).toBe(1);
  });

  it("includes crossFileIssues in filesWithErrors count", () => {
    const html = (id: string) => `<!DOCTYPE html><html><body><div data-vibeflow-id="${id}">X</div></body></html>`;
    writeFileSync(join(tempDir, "a.html"), html("shared"), "utf-8");
    writeFileSync(join(tempDir, "b.html"), html("shared"), "utf-8");

    const result = validateDirectory(tempDir);
    expect(result.crossFileIssues.length).toBeGreaterThan(0);
    // Cross-file issues add 1 to filesWithErrors
    expect(result.stats.filesWithErrors).toBe(1);
  });

  it("stats.filesChecked equals number of HTML files", () => {
    const html = (id: string) => `<!DOCTYPE html><html><body><div data-vibeflow-id="${id}">X</div></body></html>`;
    writeFileSync(join(tempDir, "one.html"), html("a"), "utf-8");
    writeFileSync(join(tempDir, "two.html"), html("b"), "utf-8");
    writeFileSync(join(tempDir, "three.html"), html("c"), "utf-8");

    const result = validateDirectory(tempDir);
    expect(result.stats.filesChecked).toBe(3);
  });
});

describe("isDirectory", () => {
  it("returns true for an existing directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "proto-isdir-"));
    try {
      expect(isDirectory(tempDir)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns false for a non-existent path (catch branch)", () => {
    expect(isDirectory("/does/not/exist/at/all")).toBe(false);
  });
});
