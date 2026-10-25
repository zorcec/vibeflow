/**
 * Pure unit tests for the shared attribution rule (ticket 0b7c45c5).
 *
 * `resolveAttribution` is the ONE rule every surface reads — card, details
 * tab, activity feed, both boards. These tests pin the rule itself; the
 * render tests pin that every surface actually uses it.
 */
import { describe, it, expect } from "vitest";
import {
  resolveAttribution,
  attributionGroupKey,
  AGENT_ACTOR_MARKER,
} from "./attribution";

describe("resolveAttribution", () => {
  it("agent vocabulary + joined human name → agent with the human", () => {
    expect(
      resolveAttribution({ author: "agent", authorName: "Tomislav Zorcec" }),
    ).toEqual({ kind: "agent", human: "Tomislav Zorcec", isAgent: true });
  });

  it("human vocabulary + joined name → human, no badge", () => {
    expect(
      resolveAttribution({ author: "user", authorName: "Tomislav Zorcec" }),
    ).toEqual({ kind: "human", human: "Tomislav Zorcec", isAgent: false });
  });

  it("legacy free-text author stays the human, unchanged", () => {
    expect(resolveAttribution({ author: "Tomislav Zorcec" })).toEqual({
      kind: "human",
      human: "Tomislav Zorcec",
      isAgent: false,
    });
  });

  it("viewer fallback applies when the record names nobody", () => {
    expect(resolveAttribution({ author: "user", viewer: "Tomislav Zorcec" })).toEqual({
      kind: "human",
      human: "Tomislav Zorcec",
      isAgent: false,
    });
  });

  it("explicit flag names the human from the author string", () => {
    expect(
      resolveAttribution({ author: "Tomislav Zorcec", agent: true }),
    ).toEqual({ kind: "agent", human: "Tomislav Zorcec", isAgent: true });
  });

  it("broadcast marker alone proves the agent, human honestly unknown", () => {
    expect(resolveAttribution({ author: AGENT_ACTOR_MARKER })).toEqual({
      kind: "agent",
      human: null,
      isAgent: true,
    });
  });

  it("API rows keep their legacy marker, never an agent badge", () => {
    expect(
      resolveAttribution({ author: "API", authorName: "Tomislav Zorcec" }),
    ).toEqual({ kind: "api", human: "Tomislav Zorcec", isAgent: false });
  });

  it("empty attribution is unknown and unbadged — never a bare agent", () => {
    expect(resolveAttribution({})).toEqual({
      kind: "unknown",
      human: null,
      isAgent: false,
    });
    expect(resolveAttribution({ viewer: "" })).toEqual({
      kind: "unknown",
      human: null,
      isAgent: false,
    });
  });

  it("source alone is NOT agent evidence", () => {
    // 'cli' only says which binary wrote the row (SourceBadge covers that
    // separately) — it must never badge a human row as an agent.
    expect(
      resolveAttribution({ author: "user", authorName: "Ada", source: undefined }),
    ).toEqual({ kind: "human", human: "Ada", isAgent: false });
  });
});

describe("attributionGroupKey", () => {
  it("agent rows group by human, never by the bare marker", () => {
    const a = resolveAttribution({ author: "agent", authorName: "Ada" });
    const b = resolveAttribution({ author: "agent", authorName: "Tomislav Zorcec" });
    const c = resolveAttribution({ author: "agent", authorName: "Ada" });
    expect(attributionGroupKey(a)).toBe(attributionGroupKey(c));
    expect(attributionGroupKey(a)).not.toBe(attributionGroupKey(b));
  });

  it("marker-only rows never merge into named rows", () => {
    const named = resolveAttribution({ author: "agent", authorName: "Ada" });
    const marker = resolveAttribution({ author: AGENT_ACTOR_MARKER });
    expect(attributionGroupKey(named)).not.toBe(attributionGroupKey(marker));
  });
});
