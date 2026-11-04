/**
 * Shared fuzzy matcher (ticket mq8azbxthl824162fnr4at49) — the ONE ranker
 * every search surface sorts by, so ranking is identical everywhere.
 */
import { describe, it, expect } from "vitest";
import {
  tokenizeSearchQuery,
  fuzzyScoreTokens,
  rankFuzzySearch,
  SEARCH_ORDER,
} from "../fuzzy-search.js";

describe("tokenizeSearchQuery", () => {
  it("lowercases and splits on whitespace", () => {
    expect(tokenizeSearchQuery("  Fix  WIDGET\nExport ")).toEqual([
      "fix",
      "widget",
      "export",
    ]);
  });

  it("blank query tokenizes to nothing", () => {
    expect(tokenizeSearchQuery("   ")).toEqual([]);
  });
});

describe("fuzzyScoreTokens", () => {
  it("exact substring scores 0 at field start", () => {
    expect(fuzzyScoreTokens(["fix"], { title: "Fix the widget" })).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScoreTokens(["WIDGET"], { title: "fix the widget" })).not.toBeNull();
  });

  it("tolerates a dropped char (subsequence, not substring)", () => {
    // "fx" is not a substring of the title, but is a subsequence of "fix".
    const hay = { title: "Fix the widget", description: "", tags: [], comments: [] };
    expect("fx".includes("ix")).toBe(false);
    expect(fuzzyScoreTokens(["fx"], hay)).not.toBeNull();
  });

  it("returns null when any token matches nowhere (AND semantics)", () => {
    expect(
      fuzzyScoreTokens(["fix", "zzzqqq"], { title: "Fix the widget" }),
    ).toBeNull();
  });

  it("searches description, tags and comments — not just title", () => {
    expect(
      fuzzyScoreTokens(["quux"], { title: "Unrelated", description: "has quux here" }),
    ).not.toBeNull();
    expect(
      fuzzyScoreTokens(["quux"], { title: "Unrelated", tags: ["quux-tag"] }),
    ).not.toBeNull();
    expect(
      fuzzyScoreTokens(["quux"], { title: "Unrelated", comments: ["a quux note"] }),
    ).not.toBeNull();
  });

  it("earlier + tighter matches score lower", () => {
    const early = fuzzyScoreTokens(["fix"], { title: "Fix later words here" });
    const late = fuzzyScoreTokens(["fix"], { title: "Some words before fix" });
    expect(early).not.toBeNull();
    expect(late).not.toBeNull();
    expect(early!).toBeLessThan(late!);
  });
});

describe("rankFuzzySearch", () => {
  const items = [
    { id: "b", title: "Some words before fix" },
    { id: "a", title: "Fix the widget" },
    { id: "c", title: "Unrelated task" },
  ];
  const pick = (t: { id: string; title: string }) => ({ id: t.id, title: t.title });

  it("returns matching ids in relevance order, non-matches excluded", () => {
    const hits = rankFuzzySearch("fix", items, pick);
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("breaks score ties by id ascending (deterministic across surfaces)", () => {
    const tied = [
      { id: "z2", title: "Fix it" },
      { id: "z1", title: "Fix it" },
    ];
    const hits = rankFuzzySearch(
      "fix",
      tied,
      (t: { id: string; title: string }) => ({ id: t.id, title: t.title }),
    );
    expect(hits.map((h) => h.id)).toEqual(["z1", "z2"]);
  });

  it("blank query returns everything at score 0 in id order", () => {
    const hits = rankFuzzySearch("  ", items, pick);
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
  });

  it("exposes the shared order spelling", () => {
    expect([...SEARCH_ORDER]).toEqual(["score:asc", "id:asc"]);
  });
});
