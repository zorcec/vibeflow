import { describe, it, expect } from "vitest";

import {
  PERSISTED_COMMENT_TEXT_MAX,
  TASK_RECORD_SCHEMA_VERSION,
  parseTaskRecord,
  toCanonicalBytes,
  validateRecordDomain,
  type TaskRecord,
} from "../task-record";

import openLabels from "./fixtures/task-record-open-labels.json";

const base = {
  schemaVersion: TASK_RECORD_SCHEMA_VERSION,
  id: "t1",
  title: "Hello",
  status: "todo",
  created: "2026-03-01T10:00:00Z",
} as const;

describe("parseTaskRecord", () => {
  it("accepts a minimal valid record", () => {
    const r = parseTaskRecord({ ...base });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.id).toBe("t1");
      expect(r.record.schemaVersion).toBe(1);
    }
  });

  it("accepts every column-only field (links, tags, commits, openedBy, expandedBy, verified, annotatedElementText, branchName)", () => {
    const r = parseTaskRecord({
      ...base,
      tags: ["a"],
      links: [{ taskId: "t2", type: "parent" }],
      commits: [
        {
          sha: "abc",
          message: "fix",
          timestamp: "2026-03-04T10:00:00Z",
        },
      ],
      openedBy: ["u1"],
      expandedBy: ["u2"],
      verified: true,
      annotatedElementText: "Buy milk",
      branchName: "feat/x",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a server-minted files[].id (a37abf9f) and preserves it", () => {
    const r = parseTaskRecord({
      ...base,
      files: [
        {
          schemaVersion: 1,
          id: "gbfvlupweyuio4018i4xkdgi",
          name: "plan.md",
          addedAt: "2026-10-22T14:51:04.379Z",
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.files?.[0]).toMatchObject({ id: "gbfvlupweyuio4018i4xkdgi", name: "plan.md" });
  });

  it("accepts local-only fields (authStateEnc, filePath, deleted tombstones)", () => {
    const task = parseTaskRecord({
      ...base,
      authStateEnc: "legacy-secret",
      filePath: ".vibeflow/tasks/2026-03-01/t1.json",
      deleted: true,
    });
    expect(task.ok).toBe(true);
    const comment = parseTaskRecord({
      ...base,
      comments: [
        {
          schemaVersion: 1,
          id: "c1",
          author: "user",
          text: "gone",
          createdAt: "2026-03-02T10:00:00Z",
          deleted: true,
        },
      ],
    });
    expect(comment.ok).toBe(true);
  });

  // Minimal derived fixtures retain the measured labels/SHA, not full live records.
  for (const fixture of openLabels) {
    it(`preserves every key and value through canonical bytes: ${fixture.name}`, () => {
      const parsed = parseTaskRecord(fixture.record);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
      expect(parsed.record).toStrictEqual(fixture.record);
      const bytes = toCanonicalBytes(parsed.record);
      // Serializing the input directly is an independent witness that parsing
      // introduced no defaults, trimmed no label and dropped no nested key.
      expect(bytes).toBe(toCanonicalBytes(fixture.record as TaskRecord));
      expect(JSON.parse(bytes)).toStrictEqual(fixture.record);
      if (fixture.record.comments) {
        const author = fixture.record.comments[0].author;
        expect(bytes).toContain(`"author": ${JSON.stringify(author)}`);
      } else {
        expect(bytes).toContain('"sha": ""');
      }
      const reparsed = parseTaskRecord(JSON.parse(bytes));
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) expect(toCanonicalBytes(reparsed.record)).toBe(bytes);
    });
  }

  it.each([
    ["empty string", { author: "" }],
    ["number", { author: 42 }],
    ["boolean", { author: true }],
    ["object", { author: {} }],
    ["array", { author: [] }],
    ["null", { author: null }],
    ["missing", {}],
  ])("rejects %s comment author", (_name, author) => {
    const parsed = parseTaskRecord({
      ...base,
      comments: [{ schemaVersion: 1, id: "c1", text: "hi", createdAt: base.created, ...author }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((issue) => issue.path)).toContain("comments[0].author");
  });

  it.each([
    ["non-string", { sha: 42 }],
    ["missing", {}],
    ["overlong", { sha: "a".repeat(256) }],
  ])("still rejects %s commit SHA", (_name, sha) => {
    const parsed = parseTaskRecord({
      ...base,
      commits: [{ message: "pending", timestamp: base.created, ...sha }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((issue) => issue.path)).toContain("commits[0].sha");
  });

  it("rejects unknown keys (strict)", () => {
    const r = parseTaskRecord({ ...base, nope: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown nested keys", () => {
    const r = parseTaskRecord({
      ...base,
      comments: [
        {
          schemaVersion: 1,
          id: "c1",
          author: "user",
          text: "hi",
          createdAt: "2026-03-02T10:00:00Z",
          content: "alias-should-not-sneak-in",
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("accepts Chore as type verbatim (free-form, not a closed enum)", () => {
    const r = parseTaskRecord({ ...base, type: "Chore" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.type).toBe("Chore");
  });

  it("rejects the [object Object] artifact as type", () => {
    expect(parseTaskRecord({ ...base, type: "[object Object]" }).ok).toBe(
      false,
    );
  });

  it("accepts a 30,045-char persisted comment (B03: persisted cap, not the 10k authoring cap)", () => {
    const text = "x".repeat(30_045);
    expect(text.length).toBe(30_045);
    expect(PERSISTED_COMMENT_TEXT_MAX).toBe(1_000_000);
    const r = parseTaskRecord({
      ...base,
      comments: [
        {
          schemaVersion: 1,
          id: "c-long",
          author: "agent",
          text,
          createdAt: "2026-03-02T10:00:00Z",
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects null anywhere (absent is the only no-value spelling)", () => {
    expect(parseTaskRecord({ ...base, title: null }).ok).toBe(false);
    expect(
      validateRecordDomain({ ...base, title: null }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects an own undefined property (would hash like absent)", () => {
    const input: Record<string, unknown> = { ...base };
    Object.defineProperty(input, "title", {
      value: undefined,
      enumerable: true,
    });
    const issues = validateRecordDomain(input);
    expect(issues.some((i) => i.code === "domain_undefined")).toBe(true);
    expect(parseTaskRecord(input).ok).toBe(false);
  });

  it("toCanonicalBytes sorts keys, pretty-prints and ends with a newline", () => {
    const r = parseTaskRecord({ ...base, tags: ["b", "a"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const bytes = toCanonicalBytes(r.record);
      expect(bytes.endsWith("\n")).toBe(true);
      expect(bytes.indexOf('"created"')).toBeLessThan(
        bytes.indexOf('"title"'),
      );
      // Array order preserved (not sorted).
      expect(bytes.indexOf('"b"')).toBeLessThan(bytes.indexOf('"a"'));
    }
  });
});
