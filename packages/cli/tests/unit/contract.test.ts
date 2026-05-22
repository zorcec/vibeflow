import { describe, it, expect } from "vitest";
import { validateHtml } from "../../src/core/contract.js";

describe("validateHtml", () => {
  const validHtml = `<!DOCTYPE html>
<html><head><title>Test</title></head>
<body>
  <div data-vibeflow-id="hero">Hero Section</div>
  <button data-vibeflow-id="cta">Click me</button>
</body></html>`;

  it("passes for valid HTML with proto-ids", () => {
    const result = validateHtml(validHtml);
    expect(result.valid).toBe(true);
    expect(result.stats.elementsWithIds).toBe(2);
    expect(result.issues.filter((i) => i.type === "error")).toHaveLength(0);
  });

  it("reports missing proto-ids from previous version", () => {
    const current = `<div data-vibeflow-id="hero">Hero</div>`;
    const previousIds = ["hero", "cta", "footer"];

    const result = validateHtml(current, previousIds);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter((i) => i.type === "error");
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toContain("cta");
    expect(errors[1].message).toContain("footer");
  });

  it("warns about non-CDN external dependencies", () => {
    const html = `<html><head>
<script src="https://cdn.example.com/lib.js"></script>
</head><body><div data-vibeflow-id="x">Hi</div></body></html>`;

    const result = validateHtml(html);
    const warnings = result.issues.filter(
      (i) => i.type === "warning" && i.message.includes("Non-CDN"),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("does not warn about allowed CDN dependencies", () => {
    const html = `<html><head>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet">
</head><body><div data-vibeflow-id="x">Hi</div></body></html>`;

    const result = validateHtml(html);
    const cdnWarnings = result.issues.filter(
      (i) => i.type === "warning" && i.message.includes("Non-CDN"),
    );
    expect(cdnWarnings).toHaveLength(0);
  });

  it("warns when no data-vibeflow-id attributes found", () => {
    const html = `<html><body><div>No ids here</div></body></html>`;
    const result = validateHtml(html);
    const warnings = result.issues.filter(
      (i) => i.message.includes("No data-vibeflow-id"),
    );
    expect(warnings).toHaveLength(1);
  });

  it("detects duplicate proto-ids", () => {
    const html = `<div data-vibeflow-id="dup">A</div>
<div data-vibeflow-id="dup">B</div>
<div data-vibeflow-id="unique">C</div>`;

    const result = validateHtml(html);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter(
      (i) => i.type === "error" && i.message.includes("Duplicate"),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("dup");
  });

  it("returns invalid for empty content", () => {
    const result = validateHtml("");
    expect(result.valid).toBe(false);
  });

  it("passes when all previous IDs are present", () => {
    const html = `<div data-vibeflow-id="a">A</div>
<div data-vibeflow-id="b">B</div>`;

    const result = validateHtml(html, ["a", "b"]);
    expect(result.valid).toBe(true);
  });

  it("handles combined issues", () => {
    const html = `<div data-vibeflow-id="x">Content</div>
<script src="https://cdn.example.com/lib.js"></script>`;

    const result = validateHtml(html, ["x", "missing-id"]);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});
