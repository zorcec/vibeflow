/**
 * Path-based kanban deep links: `/kanban/<task-id>[/<tab>]`.
 *
 * Pure helper contract — no DOM, no server boot.
 */
import { describe, it, expect } from "vitest";
import {
  parseKanbanDeepLink,
  taskPanelUrl,
  panelHistoryKey,
} from "../../src/client/kanban/deep-link.js";

const ID = "d89a3009abf34626c7f31f14ea08a0";

describe("parseKanbanDeepLink", () => {
  it("opens a bare task id on details", () => {
    expect(parseKanbanDeepLink(`/kanban/${ID}`)).toEqual({
      taskId: ID,
      tab: "details",
    });
  });

  it("maps /activity to the comments tab", () => {
    expect(parseKanbanDeepLink(`/kanban/${ID}/activity`)).toEqual({
      taskId: ID,
      tab: "comments",
    });
  });

  it("accepts /comments as an alias of /activity", () => {
    expect(parseKanbanDeepLink(`/kanban/${ID}/comments`)).toEqual({
      taskId: ID,
      tab: "comments",
    });
  });

  it("accepts /details and /files explicitly", () => {
    expect(parseKanbanDeepLink(`/kanban/${ID}/details`)).toEqual({
      taskId: ID,
      tab: "details",
    });
    expect(parseKanbanDeepLink(`/kanban/${ID}/files`)).toEqual({
      taskId: ID,
      tab: "files",
    });
  });

  it("is case-insensitive for ids and slugs", () => {
    expect(
      parseKanbanDeepLink(`/kanban/${ID.toUpperCase()}/Activity`),
    ).toEqual({ taskId: ID, tab: "comments" });
  });

  it("falls back to details for an unknown tab slug (task still opens)", () => {
    expect(parseKanbanDeepLink(`/kanban/${ID}/bogus`)).toEqual({
      taskId: ID,
      tab: "details",
    });
  });

  it("ignores a trailing slash", () => {
    expect(parseKanbanDeepLink(`/kanban/${ID}/`)).toEqual({
      taskId: ID,
      tab: "details",
    });
  });

  it("returns null for the plain board and non-kanban paths", () => {
    expect(parseKanbanDeepLink("/kanban")).toBeNull();
    expect(parseKanbanDeepLink("/kanban/")).toBeNull();
    expect(parseKanbanDeepLink("/")).toBeNull();
    expect(parseKanbanDeepLink(`/tasks/${ID}`)).toBeNull();
  });

  it("returns null for short/non-hex ids", () => {
    expect(parseKanbanDeepLink("/kanban/activity")).toBeNull();
    expect(parseKanbanDeepLink("/kanban/abc123")).toBeNull();
    expect(parseKanbanDeepLink("/kanban/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
  });

  it("returns null for deeper paths", () => {
    expect(parseKanbanDeepLink(`/kanban/${ID}/activity/extra`)).toBeNull();
  });
});

describe("taskPanelUrl", () => {
  it("emits the bare id for details (canonical short form)", () => {
    expect(taskPanelUrl(ID, "details")).toBe(`/kanban/${ID}`);
    expect(taskPanelUrl(ID)).toBe(`/kanban/${ID}`);
  });

  it("emits /activity for the comments tab", () => {
    expect(taskPanelUrl(ID, "comments")).toBe(`/kanban/${ID}/activity`);
  });

  it("emits /files for the files tab", () => {
    expect(taskPanelUrl(ID, "files")).toBe(`/kanban/${ID}/files`);
  });

  it("round-trips through the parser", () => {
    for (const tab of ["details", "comments", "files"] as const) {
      const parsed = parseKanbanDeepLink(taskPanelUrl(ID, tab));
      expect(parsed).toEqual({ taskId: ID, tab });
    }
  });
});

describe("panelHistoryKey", () => {
  it("distinguishes task + tab", () => {
    expect(panelHistoryKey(ID, "details")).not.toBe(
      panelHistoryKey(ID, "comments"),
    );
    expect(panelHistoryKey(ID, "details")).toBe(
      panelHistoryKey(ID.toUpperCase(), "details"),
    );
  });
});
