/**
 * Unit tests for the conformance normalizer (plan §6.1).
 *
 * The normalizer is what makes "same battery, both surfaces" meaningful, so
 * every allowlist decision is pinned here — including the failure modes. A
 * test that only exercises the happy path would pass with the guard gutted;
 * each throw-branch below replays the exact divergence it must catch.
 */

import { describe, it, expect } from "vitest";
import {
  NormalizeError,
  createNormalizeContext,
  normalizeComment,
  normalizeFileRef,
  normalizeResponse,
  normalizeTask,
} from "@vibeflow-tools/api-core";

const taskFixture = () => ({
  id: "abcdef0123456789abcdef01234567".slice(0, 30),
  title: "Probe",
  description: "d",
  status: "todo",
  selector: "#app",
  created: "2026-10-13T00:00:00.000Z",
  sortKey: "a0",
  commitPushed: true,
  commentCount: 1,
  fileCount: 1,
  commits: [{ sha: "deadbeef", message: "m", timestamp: "2026-10-13T00:00:00Z" }],
  comments: [
    {
      id: "c1",
      author: "agent",
      text: "done",
      createdAt: "2026-10-13T00:00:00.000Z",
    },
  ],
  files: [{ name: "note.txt", size: 12, url: "/api/tasks/x/files/note.txt" }],
  links: [{ taskId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", type: "parent" }],
});

describe("normalizeTask", () => {
  it("strips volatile fields and maps ids through the per-run table", () => {
    const ctx = createNormalizeContext();
    const out = normalizeTask(taskFixture(), ctx, "t");
    expect(out["id"]).toBe("<id:1>");
    expect(out).not.toHaveProperty("created");
    expect(out).not.toHaveProperty("sortKey");
    expect(out).not.toHaveProperty("commitPushed");
    expect(out["title"]).toBe("Probe");
    expect(out["commentCount"]).toBe(1);
    const commits = out["commits"] as { sha: string }[];
    expect(commits[0].sha).toBe("<sha>");
    // Same raw id maps to the same placeholder across records (join key).
    const out2 = normalizeTask(
      { ...taskFixture(), title: "Other" },
      ctx,
      "t2",
    );
    expect(out2["id"]).toBe("<id:1>");
  });

  it("accepts the full D6 vocabulary incl. pass-through cancelled", () => {
    for (const status of [
      "backlog",
      "todo",
      "in-progress",
      "review",
      "done",
      "cancelled",
    ]) {
      const ctx = createNormalizeContext();
      const out = normalizeTask({ ...taskFixture(), status }, ctx, "t");
      expect(out["status"]).toBe(status);
    }
  });

  it("throws on a lossy status spelling (snake_case must map, never pass)", () => {
    const ctx = createNormalizeContext();
    expect(() =>
      normalizeTask({ ...taskFixture(), status: "in_progress" }, ctx, "t"),
    ).toThrow(NormalizeError);
  });

  it("throws on an unknown one-sided field (fail closed)", () => {
    const ctx = createNormalizeContext();
    expect(() =>
      normalizeTask(
        { ...taskFixture(), cloudOnlyWidget: true },
        ctx,
        "t",
      ),
    ).toThrow(/not in the normalizer allowlist/);
  });

  it("asserts D3 externalId form when present; requires it in strict v0", () => {
    const ctx = createNormalizeContext();
    const withBoth = normalizeTask(
      {
        ...taskFixture(),
        id: "a".repeat(30),
        externalId: "a".repeat(30),
      },
      ctx,
      "t",
    );
    expect(withBoth["id"]).toBe(withBoth["externalId"]);
    expect(() =>
      normalizeTask(taskFixture(), createNormalizeContext(), "t", true),
    ).toThrow(/both id and externalId/);
    expect(() =>
      normalizeTask(
        { ...taskFixture(), externalId: 42 },
        createNormalizeContext(),
        "t",
      ),
    ).toThrow(/must be a string/);
  });

  it("preserves a task-level author (ledger L1: never silently dropped)", () => {
    const ctx = createNormalizeContext();
    const out = normalizeTask({ ...taskFixture(), author: "user" }, ctx, "t");
    expect(out["author"]).toBe("user");
  });
});

describe("normalizeComment (ledger L1)", () => {
  const comment = () => ({
    id: "mnrrhpi0f9mxv",
    author: "agent",
    text: "L1 probe",
    createdAt: "2026-10-13T00:00:00.000Z",
  });

  it("preserves author verbatim for both vocabularies", () => {
    for (const author of ["user", "agent"]) {
      const out = normalizeComment(
        { ...comment(), author },
        createNormalizeContext(),
        "c",
      );
      expect(out["author"]).toBe(author);
    }
  });

  it("throws when author is absent — actor semantics would go uncompared", () => {
    const { author: _dropped, ...noAuthor } = comment();
    expect(() =>
      normalizeComment(noAuthor, createNormalizeContext(), "c"),
    ).toThrow(/carries no author/);
  });

  it("throws on a rewritten/unknown author", () => {
    expect(() =>
      normalizeComment(
        { ...comment(), author: "relates" },
        createNormalizeContext(),
        "c",
      ),
    ).toThrow(/must be preserved/);
  });

  it("throws on an unknown comment field", () => {
    expect(() =>
      normalizeComment(
        { ...comment(), cloudAuthorId: "u_1" },
        createNormalizeContext(),
        "c",
      ),
    ).toThrow(/not allowlisted/);
  });
});

describe("normalizeFileRef", () => {
  it("scrubs volatile size/url while keeping name and system flag", () => {
    const out = normalizeFileRef(
      {
        name: "note.txt",
        size: 999,
        url: "/api/tasks/x/files/note.txt",
        system: true,
      },
      createNormalizeContext(),
      "f",
    );
    expect(out["name"]).toBe("note.txt");
    expect(out["system"]).toBe(true);
    expect(out["size"]).toBe("<size>");
    expect(out["url"]).toBe("<file-url>");
  });

  it("throws on an unknown file field", () => {
    expect(() =>
      normalizeFileRef(
        { name: "n", etag: "abc" },
        createNormalizeContext(),
        "f",
      ),
    ).toThrow(/not allowlisted/);
  });
});

describe("normalizeResponse envelopes", () => {
  it("accepts both v0 { items } and local { tasks } list envelopes", () => {
    const ctx = createNormalizeContext();
    const fromTasks = normalizeResponse(
      "task-list",
      { tasks: [taskFixture()] },
      ctx,
      "l",
    ) as { items: unknown[] };
    expect(fromTasks.items).toHaveLength(1);
    const fromItems = normalizeResponse(
      "task-list",
      { items: [{ ...taskFixture(), id: "b".repeat(30) }] },
      createNormalizeContext(),
      "l",
    ) as { items: { id: string }[] };
    expect(fromItems.items[0].id).toBe("<id:1>");
  });

  it("rejects a list with neither envelope", () => {
    expect(() =>
      normalizeResponse("task-list", { data: [] }, createNormalizeContext(), "l"),
    ).toThrow(/neither \{ items \} nor \{ tasks \}/);
  });

  it("rejects an unknown shape", () => {
    expect(() =>
      normalizeResponse("widget", {}, createNormalizeContext(), "w"),
    ).toThrow(/unknown response shape/);
  });

  it("screenshot-result asserts success + filename, scrubs the id-bearing name", () => {
    const ctx = createNormalizeContext();
    const out = normalizeResponse(
      "screenshot-result",
      { success: true, screenshot: "cmgb1234.png" },
      ctx,
      "put-screenshot/green",
    ) as Record<string, unknown>;
    expect(out).toEqual({ success: true, screenshot: "<screenshot>" });
    // success:false (or missing) is a failure, never a silent pass.
    expect(() =>
      normalizeResponse(
        "screenshot-result",
        { success: false, screenshot: "x.png" },
        createNormalizeContext(),
        "s",
      ),
    ).toThrow(/success: true/);
    expect(() =>
      normalizeResponse(
        "screenshot-result",
        { success: true },
        createNormalizeContext(),
        "s",
      ),
    ).toThrow(/screenshot filename/);
  });
});
