import { describe, it, expect, vi, beforeEach } from "vitest";
import { escapeMd } from "../../src/telegram/status-manager.js";

describe("escapeMd", () => {
  it("escapes periods", () => {
    expect(escapeMd("hello.world")).toBe("hello\\.world");
  });

  it("escapes exclamation marks", () => {
    expect(escapeMd("hello!")).toBe("hello\\!");
  });

  it("escapes parentheses", () => {
    expect(escapeMd("text (with parens)")).toBe("text \\(with parens\\)");
  });

  it("escapes brackets", () => {
    expect(escapeMd("[text]")).toBe("\\[text\\]");
  });

  it("escapes braces", () => {
    expect(escapeMd("{text}")).toBe("\\{text\\}");
  });

  it("escapes plus signs", () => {
    expect(escapeMd("a+b")).toBe("a\\+b");
  });

  it("escapes minus signs", () => {
    expect(escapeMd("a-b")).toBe("a\\-b");
  });

  it("escapes equals signs", () => {
    expect(escapeMd("a=b")).toBe("a\\=b");
  });

  it("escapes hash signs", () => {
    expect(escapeMd("#heading")).toBe("\\#heading");
  });

  it("escapes pipe characters", () => {
    expect(escapeMd("a|b")).toBe("a\\|b");
  });

  it("escapes tilde", () => {
    expect(escapeMd("~text~")).toBe("\\~text\\~");
  });

  it("escapes backtick", () => {
    expect(escapeMd("`code`")).toBe("\\`code\\`");
  });

  it("escapes greater than", () => {
    expect(escapeMd("> quote")).toBe("\\> quote");
  });

  it("escapes underscore", () => {
    expect(escapeMd("a_b")).toBe("a\\_b");
  });

  it("handles empty string", () => {
    expect(escapeMd("")).toBe("");
  });

  it("handles string with no special characters", () => {
    expect(escapeMd("hello world")).toBe("hello world");
  });

  it("handles multiple special characters", () => {
    const input = "Price: $10.99 (50% off!)";
    const result = escapeMd(input);
    expect(result).toContain("\\.");
    expect(result).toContain("\\!");
    expect(result).toContain("\\(");
    expect(result).toContain("\\)");
  });

  it("escapes all MarkdownV2 special characters", () => {
    const specialChars = "_*[]()~`>#+=|{}.!\\-";
    const result = escapeMd(specialChars);
    // Each character should be escaped
    for (const char of specialChars) {
      expect(result).toContain(`\\${char}`);
    }
  });
});
