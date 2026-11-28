/**
 * `.vibeflow/notifications-filter.json` + the repeatable `--filter-*` flags
 * (ticket za93ov003x6rbqv2xy9detoo, mock #5c).
 *
 * The properties, in the order they can go wrong:
 * - a broken config never becomes a silent empty feed: unreadable / invalid
 *   JSON warns ONCE and follows unfiltered, an invalid value drops THAT
 *   dimension (the rest of the file still applies), an unknown key warns and
 *   is ignored;
 * - flags win per dimension over the file — an explicit CLI intent beats a
 *   stale file without editing it, and an invalid flag value warns and drops
 *   that dimension instead of reaching the board for a 400;
 * - serialisation repeats the param per value (`actor=a&actor=b`) and never
 *   emits a blank element;
 * - the preview line's numbers ARE the server's filteredCount.
 *
 * Mutation not run (on-request only).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendNotificationsFilterParams,
  loadNotificationsFilter,
  NOTIFICATIONS_FILTER_CONFIG_DIMENSIONS,
  NOTIFICATIONS_FILTER_FILENAME,
  renderNotificationsFilterPreview,
} from "../../src/core/notifications-filter-config.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "vf-notif-filter-"));
  mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writeConfig(contents: string): void {
  writeFileSync(
    join(projectDir, ".vibeflow", NOTIFICATIONS_FILTER_FILENAME),
    contents,
    "utf8",
  );
}

describe("loadNotificationsFilter — the config file", () => {
  it("a missing file is the default: no filter, no warning", () => {
    const loaded = loadNotificationsFilter(projectDir);
    expect(loaded.filter).toEqual({});
    expect(loaded.warnings).toEqual([]);
  });

  it("loads a valid file with every dimension of the strict schema", () => {
    writeConfig(
      JSON.stringify({
        taskType: ["Research"],
        type: ["task.comment"],
        actor: ["pi-a", "pi-b"],
        status: ["in-progress"],
        taskId: ["abc123"],
      }),
    );
    const loaded = loadNotificationsFilter(projectDir);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.filter).toEqual({
      taskType: ["Research"],
      type: ["task.comment"],
      actor: ["pi-a", "pi-b"],
      status: ["in-progress"],
      taskId: ["abc123"],
    });
    // The schema is closed: exactly these five, no more.
    expect([...NOTIFICATIONS_FILTER_CONFIG_DIMENSIONS]).toEqual([
      "taskType",
      "type",
      "actor",
      "status",
      "taskId",
    ]);
  });

  it("an unknown key warns and is ignored; the rest of the file still applies", () => {
    writeConfig(
      JSON.stringify({ type: ["task.comment"], agent: ["pi-a"], bogus: [1] }),
    );
    const loaded = loadNotificationsFilter(projectDir);
    expect(loaded.filter).toEqual({ type: ["task.comment"] });
    expect(loaded.warnings).toHaveLength(2);
    expect(loaded.warnings[0]).toContain("`agent`");
    expect(loaded.warnings[0]).toContain("unknown dimension");
    expect(loaded.warnings[1]).toContain("`bogus`");
  });

  it("an invalid value drops THAT dimension only, with a warning naming it", () => {
    writeConfig(
      JSON.stringify({
        actor: ["x".repeat(129)],
        type: ["task.comment"],
        status: [""],
      }),
    );
    const loaded = loadNotificationsFilter(projectDir);
    expect(loaded.filter).toEqual({ type: ["task.comment"] });
    expect(loaded.warnings).toHaveLength(2);
    expect(loaded.warnings[0]).toContain("`actor`");
    expect(loaded.warnings[0]).toContain("129 characters");
    expect(loaded.warnings[1]).toContain("`status`");
  });

  it("a non-array value for a known key drops that dimension", () => {
    writeConfig(JSON.stringify({ status: "in-progress" }));
    const loaded = loadNotificationsFilter(projectDir);
    expect(loaded.filter).toEqual({});
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("`status` must be an array");
  });

  it("invalid JSON warns ONCE and follows unfiltered (never a silent empty feed)", () => {
    writeConfig("{ this is not json");
    const loaded = loadNotificationsFilter(projectDir);
    expect(loaded.filter).toEqual({});
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("not valid JSON");
    expect(loaded.warnings[0]).toContain("following unfiltered");
  });

  it("an unreadable file (the path is a directory) warns once and follows unfiltered", () => {
    mkdirSync(join(projectDir, ".vibeflow", NOTIFICATIONS_FILTER_FILENAME));
    const loaded = loadNotificationsFilter(projectDir);
    expect(loaded.filter).toEqual({});
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("unreadable");
  });

  it("a non-object file warns once and follows unfiltered", () => {
    writeConfig('["task.comment"]');
    const loaded = loadNotificationsFilter(projectDir);
    expect(loaded.filter).toEqual({});
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("must be a JSON object");
  });

  it("bypassFile ignores the file entirely — no filter, no warnings", () => {
    writeConfig(JSON.stringify({ actor: ["pi-a"] }));
    const loaded = loadNotificationsFilter(projectDir, { bypassFile: true });
    expect(loaded.filter).toEqual({});
    expect(loaded.warnings).toEqual([]);
  });
});

describe("loadNotificationsFilter — flags over file", () => {
  it("flags win PER DIMENSION; untouched dimensions keep the file's values", () => {
    writeConfig(
      JSON.stringify({ actor: ["pi-a"], type: ["task.create"] }),
    );
    const loaded = loadNotificationsFilter(projectDir, {
      flags: { actor: ["pi-b"] },
    });
    expect(loaded.filter).toEqual({
      actor: ["pi-b"],
      type: ["task.create"],
    });
    expect(loaded.warnings).toEqual([]);
  });

  it("repeated flags collect into one OR list", () => {
    const loaded = loadNotificationsFilter(projectDir, {
      flags: { actor: ["pi-a", "pi-b"] },
    });
    expect(loaded.filter).toEqual({ actor: ["pi-a", "pi-b"] });
  });

  it("an invalid flag value warns and drops that dimension", () => {
    writeConfig(JSON.stringify({ actor: ["pi-a"] }));
    const loaded = loadNotificationsFilter(projectDir, {
      flags: { actor: [""] },
    });
    expect(loaded.filter).toEqual({});
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("--filter-actor");
  });
});

describe("appendNotificationsFilterParams — the wire", () => {
  it("repeats the param once per value (OR), in declaration order", () => {
    const url = new URL("http://localhost/api/notifications?limit=5");
    appendNotificationsFilterParams(url, { actor: ["a", "b"] });
    expect(url.searchParams.getAll("actor")).toEqual(["a", "b"]);
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("never emits a blank element or an all-blank dimension", () => {
    const url = new URL("http://localhost/api/notifications");
    appendNotificationsFilterParams(url, { type: ["", "  "] });
    expect(url.searchParams.has("type")).toBe(false);
    const empty = new URL("http://localhost/api/notifications");
    appendNotificationsFilterParams(empty, {});
    expect(empty.searchParams.toString()).toBe("");
  });

  it("an absent filter leaves the URL untouched", () => {
    const url = new URL("http://localhost/api/notifications?since=x");
    appendNotificationsFilterParams(url, undefined);
    expect(url.searchParams.toString()).toBe("since=x");
  });
});

describe("renderNotificationsFilterPreview — the honest numbers", () => {
  it("derives window/delivered/filtered from the SERVER's answer", () => {
    const line = renderNotificationsFilterPreview(
      { actor: ["pi-a"], type: ["task.create", "task.comment"] },
      { count: 4, filteredCount: 1 },
    );
    // N = count + filteredCount, M = count, K = filteredCount — no client
    // tally anywhere: `|` joins OR-values, `, ` separates dimensions, and the
    // dimension order is the schema's (type before actor).
    expect(line).toBe(
      "filters: type=task.create|task.comment, actor=pi-a · 5 events in window, 4 delivered, 1 filtered",
    );
  });

  it("says a filter that matched nothing out loud instead of hiding it", () => {
    const line = renderNotificationsFilterPreview(
      { taskType: ["Waterfall"] },
      { count: 0, filteredCount: 3 },
    );
    expect(line).toBe(
      "filters: taskType=Waterfall · 3 events in window, 0 delivered, 3 filtered",
    );
  });
});
