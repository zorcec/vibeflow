/**
 * Field-level activity entries (3647a4715eeebe2a2ce02571a58c91).
 *
 * The detail-pane feed logs every details-field save as ONE minimal row:
 * which field changed, never a value dump. Short fields keep the feed's
 * established from→to pills; long/structural fields (description, tags,
 * relations) render name-only.
 *
 * Non-vacuity: the name-only cases fail on the old code (every change row
 * rendered pills); the pill case fails if the convention regresses.
 */
import { describe, it, expect } from "vitest";
import {
  diffTaskFields,
  MINIMAL_FIELDS,
  verifyLabel,
  tagSetKey,
  normalizeTagList,
  parseTagKey,
  diffTagLists,
  resolveTagChange,
  formatTagChange,
  linkSetKey,
} from "../fieldChanges";
import type { Task } from "../types";

const base = (overrides: Partial<Task> = {}): Partial<Task> => ({
  title: "Same title",
  description: "Same description",
  type: "Task",
  priority: "Medium",
  tags: ["a"],
  links: [],
  verified: undefined,
  status: "todo",
  ...overrides,
});

describe("MINIMAL_FIELDS", () => {
  it("holds exactly description, tags and relations", () => {
    expect([...MINIMAL_FIELDS].sort()).toEqual([
      "description",
      "relations",
      "tags",
    ]);
  });
});

describe("diffTaskFields", () => {
  it("returns nothing when snapshots match", () => {
    expect(diffTaskFields(base(), base())).toEqual([]);
  });

  it("returns nothing for null snapshots", () => {
    expect(diffTaskFields(null, base())).toEqual([]);
    expect(diffTaskFields(base(), undefined)).toEqual([]);
  });

  it("diffs a description edit as one entry", () => {
    expect(
      diffTaskFields(base(), base({ description: "New description" })),
    ).toEqual([
      { field: "description", from: "Same description", to: "New description" },
    ]);
  });

  it("trims text before comparing (no phantom entries on whitespace)", () => {
    expect(
      diffTaskFields(base(), base({ title: "  Same title  " })),
    ).toEqual([]);
  });

  it("diffs title, type and priority with values (pill convention)", () => {
    const out = diffTaskFields(
      base(),
      base({ title: "New", type: "Bug", priority: "High" }),
    );
    expect(out).toEqual([
      { field: "title", from: "Same title", to: "New" },
      { field: "type", from: "Task", to: "Bug" },
      { field: "priority", from: "Medium", to: "High" },
    ]);
  });

  it("diffs tags order-insensitively", () => {
    expect(
      diffTaskFields(base({ tags: ["a", "b"] }), base({ tags: ["b", "a"] })),
    ).toEqual([]);
    expect(
      diffTaskFields(base({ tags: ["a"] }), base({ tags: ["a", "b"] })),
    ).toEqual([
      { field: "tags", from: "a", to: "a,b", added: ["b"], removed: [] },
    ]);
  });

  it("records the actual added/removed tags on the tags entry (59f91dc0)", () => {
    expect(
      diffTaskFields(
        base({ tags: ["p1", "bug"] }),
        base({ tags: ["bug", "ui", "ux"] }),
      ),
    ).toEqual([
      {
        field: "tags",
        from: "bug,p1",
        to: "bug,ui,ux",
        added: ["ui", "ux"],
        removed: ["p1"],
      },
    ]);
  });

  it("diffs relations as link sets", () => {
    const link = { taskId: "abc", type: "parent" } as const;
    expect(diffTaskFields(base(), base({ links: [] }))).toEqual([]);
    expect(diffTaskFields(base(), base({ links: [link] }))).toEqual([
      { field: "relations", from: "", to: "parent:abc" },
    ]);
  });

  it("diffs a standalone verify change with indicator vocabulary", () => {
    expect(
      diffTaskFields(base(), base({ verified: true })),
    ).toEqual([{ field: "verify", from: "none", to: "verified" }]);
    expect(
      diffTaskFields(base({ verified: true }), base({ verified: false })),
    ).toEqual([{ field: "verify", from: "verified", to: "failed" }]);
  });

  it("folds branchName into the status entry on the same save", () => {
    // Apply & Review writes {status, branchName} together: one event, not two.
    expect(
      diffTaskFields(
        base(),
        base({ status: "review", branchName: "feat/x" } as Partial<Task>),
      ),
    ).toEqual([]);
    // A standalone branch write (CLI/MCP only) still yields its own entry.
    expect(
      diffTaskFields(base(), base({ branchName: "feat/x" } as Partial<Task>)),
    ).toEqual([{ field: "branch", from: "", to: "feat/x" }]);
  });

  it("emits one entry per changed field in Details-tab order", () => {
    const out = diffTaskFields(
      base(),
      base({ description: "N", tags: ["a", "z"] }),
    ).map((c) => c.field);
    expect(out).toEqual(["description", "tags"]);
  });
});

describe("verifyLabel", () => {
  it("maps the tri-state flag to indicator vocabulary", () => {
    expect(verifyLabel(true)).toBe("verified");
    expect(verifyLabel(false)).toBe("failed");
    expect(verifyLabel(null)).toBe("none");
    expect(verifyLabel(undefined)).toBe("none");
  });
});

describe("diffTagLists (59f91dc0)", () => {
  it("names added and removed tags", () => {
    expect(diffTagLists(["p1", "bug"], ["bug", "ui", "ux"])).toEqual({
      added: ["ui", "ux"],
      removed: ["p1"],
    });
  });

  it("is order-insensitive and trims", () => {
    expect(diffTagLists(["b", "a"], ["a", "b"]))
      .toEqual({ added: [], removed: [] });
    expect(diffTagLists(["  a "], ["a", "b"])).toEqual({
      added: ["b"],
      removed: [],
    });
  });

  it("diffs comma-containing tags exactly (keys cannot)", () => {
    // TagInput takes the whole input as one tag, so "a,b" can be a
    // SINGLE tag: key parsing would mis-split it, the array diff does not.
    expect(diffTagLists(["x"], ["x", "a,b"])).toEqual({
      added: ["a,b"],
      removed: [],
    });
  });
});

describe("resolveTagChange (59f91dc0)", () => {
  it("prefers arrays recorded at diff time", () => {
    expect(resolveTagChange("a", "a,b", ["b"], [])).toEqual({
      added: ["b"],
      removed: [],
    });
  });

  it("derives the diff from stored keys on pre-fix records", () => {
    expect(resolveTagChange("bug,p1", "bug,ui,ux")).toEqual({
      added: ["ui", "ux"],
      removed: ["p1"],
    });
  });
});

describe("formatTagChange (59f91dc0)", () => {
  it("names added and removed tags", () => {
    expect(formatTagChange(["bug", "ui"], ["p1"])).toBe(
      "added: bug, ui · removed: p1",
    );
  });

  it("names just the changed side", () => {
    expect(formatTagChange(["b"], [])).toBe("added: b");
    expect(formatTagChange([], ["a"])).toBe("removed: a");
  });
});

describe("normalizeTagList / parseTagKey", () => {
  it("normalizes and round-trips comma-free tags", () => {
    expect(normalizeTagList([" b ", "a", "", 1])).toEqual(["a", "b"]);
    expect(parseTagKey("a,b")).toEqual(["a", "b"]);
    expect(parseTagKey("")).toEqual([]);
  });
});

describe("tagSetKey / linkSetKey", () => {
  it("ignores non-string tag members", () => {
    expect(tagSetKey(["a", 1, null])).toBe("a");
    expect(tagSetKey(undefined)).toBe("");
  });

  it("ignores malformed links", () => {
    expect(linkSetKey([{ nope: 1 }])).toBe("");
    expect(linkSetKey(undefined)).toBe("");
  });
});
