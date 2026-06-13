import { describe, it, expect } from "vitest";
import { formatForTelegram, splitMessage } from "../../src/telegram/format.js";

describe("formatForTelegram", () => {
  it("returns empty string for empty input", () => {
    expect(formatForTelegram("")).toBe("");
  });

  it("returns empty string for null/undefined input", () => {
    expect(formatForTelegram(null as any)).toBe("");
    expect(formatForTelegram(undefined as any)).toBe("");
  });

  it("converts **bold** to *bold*", () => {
    expect(formatForTelegram("**hello**")).toBe("*hello*");
  });

  it("converts __underline__ to <u>underline</u>", () => {
    expect(formatForTelegram("__hello__")).toBe("<u>hello</u>");
  });

  it("converts ~~strikethrough~~ to ~strikethrough~", () => {
    expect(formatForTelegram("~~hello~~")).toBe("~hello~");
  });

  it("preserves code blocks without escaping", () => {
    const input = "```\nconst x = 1;\n```";
    expect(formatForTelegram(input)).toBe(input);
  });

  it("preserves multi-line code blocks", () => {
    const input = "```\nline1\nline2\nline3\n```";
    const result = formatForTelegram(input);
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    expect(result).toContain("line3");
  });

  it("escapes special characters in plain text", () => {
    const result = formatForTelegram("hello.world");
    expect(result).toContain("\\.");
  });

  it("preserves inline code", () => {
    const result = formatForTelegram("`code here`");
    expect(result).toContain("`code here`");
  });

  it("handles bold with inline code", () => {
    const result = formatForTelegram("**bold** and `code`");
    expect(result).toContain("*bold*");
    expect(result).toContain("`code`");
  });

  it("handles mixed content", () => {
    const input = "**bold** and `code` and ~~strike~~";
    const result = formatForTelegram(input);
    expect(result).toContain("*bold*");
    expect(result).toContain("`code`");
    expect(result).toContain("~strike~");
  });

  it("handles links", () => {
    const result = formatForTelegram("[link](http://example.com)");
    expect(result).toContain("[link](http://example.com)");
  });

  it("handles bold text", () => {
    const result = formatForTelegram("*bold*");
    expect(result).toContain("*bold*");
  });

  it("handles strikethrough text", () => {
    const result = formatForTelegram("~strike~");
    expect(result).toContain("~strike~");
  });

  it("handles underline text", () => {
    const result = formatForTelegram("<u>underline</u>");
    expect(result).toContain("<u>underline</u>");
  });

  it("handles text shorter than 2 chars for bold", () => {
    // "*a" should not be treated as bold (length <= 2)
    const result = formatForTelegram("*a");
    expect(result).toContain("\\*a");
  });
});

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    const result = splitMessage("hello");
    expect(result).toEqual(["hello"]);
  });

  it("returns single chunk for exact max length", () => {
    const msg = "a".repeat(4096);
    const result = splitMessage(msg);
    expect(result).toEqual([msg]);
  });

  it("splits long messages at double newlines", () => {
    const longMsg = "a".repeat(4000) + "\n\n" + "b".repeat(4000);
    const result = splitMessage(longMsg);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0].length).toBeLessThanOrEqual(4096);
  });

  it("splits at single newlines when no double newlines", () => {
    const longMsg = "a".repeat(4000) + "\n" + "b".repeat(4000);
    const result = splitMessage(longMsg);
    expect(result.length).toBeGreaterThan(1);
  });

  it("splits at spaces when no newlines", () => {
    const longMsg = "a ".repeat(2500);
    const result = splitMessage(longMsg);
    expect(result.length).toBeGreaterThan(1);
  });

  it("hard splits when no good split point", () => {
    const longMsg = "a".repeat(8000);
    const result = splitMessage(longMsg);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(4096);
  });

  it("preserves all content after splitting", () => {
    const longMsg = "a".repeat(4000) + "\n\n" + "b".repeat(4000);
    const result = splitMessage(longMsg);
    const rejoined = result.join("");
    expect(rejoined).toBe(longMsg);
  });

  it("does not split in the middle of a word when possible", () => {
    const longMsg = "word ".repeat(900);
    const result = splitMessage(longMsg);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});
