/**
 * Clone mode (ticket 4efaa878) — unit suite for the accepted-record extractor
 * (`extractAcceptedRecord`), the fallback mapping (`saasTaskToLocalRecord`)
 * and the local writer (`writeOnlineClone`).
 *
 * The contract under test: when the create response carries the explicit
 * `record` member (the accepted raw the server stored), the clone persists
 * it VERBATIM — no mapper, no invented defaults — plus only the two
 * load-bearing local keys (`sortKey`, `created`, same rule as pull imports).
 * Without the member (older server) the response-view mapper reconstructs
 * the closest approximation AND the writer warns loudly that the clone is
 * reconstructed, never exact. Server-only view keys (`boardId`,
 * `externalId`, counts) never enter the file — adding them would change
 * the hash inputs.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractAcceptedRecord,
  saasTaskToLocalRecord,
  writeOnlineClone,
} from "../../../src/saas/clone.js";
import type { SaasTask } from "../../../src/saas/client.js";

const cleanups: Array<() => void> = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function saasTask(patch: Partial<SaasTask> = {}): SaasTask {
  return {
    id: "abc123def456abc123def456abc12345",
    title: "Accepted task",
    description: "",
    status: "todo",
    author: null,
    priority: "Medium",
    type: "Task",
    boardId: "board-1",
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:00.000Z",
    links: [],
    comments: [],
    files: [],
    ...patch,
  };
}

describe("saasTaskToLocalRecord", () => {
  it("maps the accepted record onto local field names (createdAt/updatedAt renamed)", () => {
    expect(
      saasTaskToLocalRecord(
        saasTask({
          description: "kept",
          // SAFETY: selector rides the v0 view but the SaasTask interface
          // does not name it; the cast only feeds the mapper input.
          selector: "/#cta",
        } as unknown as SaasTask),
      ),
    ).toEqual({
      id: "abc123def456abc123def456abc12345",
      title: "Accepted task",
      description: "kept",
      status: "todo",
      priority: "Medium",
      type: "Task",
      selector: "/#cta",
      created: "2026-10-22T10:00:00.000Z",
      updated: "2026-10-22T10:00:00.000Z",
      comments: [],
      files: [],
    });
  });

  it("reconstructs the server defaults the lossy create view hides as null", () => {
    // Smoke proof (ticket 4efaa878): the create view answers
    // description:null / selector:null while the stored raw (export record
    // == inventory hash) carries "" / "/" — so the clone defaults them
    // instead of omitting the keys (omitting a stored value re-sends on
    // every push under a merging import; see saas/clone.ts).
    const record = saasTaskToLocalRecord(
      saasTask({
        description: null,
        // SAFETY: same un-named view key as above.
        selector: null,
      } as unknown as SaasTask),
    );
    expect(record.description).toBe("");
    expect(record.selector).toBe("/");
  });

  it("drops server-only keys — boardId, external id aliases and counts never enter the file", () => {
    const record = saasTaskToLocalRecord(
      saasTask({
        // SAFETY: the v0 contract carries keys the SaasTask interface does
        // not name (externalId, counts); the test proves the mapper drops
        // them rather than trusting the interface to be complete.
        externalId: "ext-1",
        commentCount: 2,
        fileCount: 1,
      } as unknown as SaasTask),
    );
    expect(record).not.toHaveProperty("boardId");
    expect(record).not.toHaveProperty("externalId");
    expect(record).not.toHaveProperty("commentCount");
    expect(record).not.toHaveProperty("fileCount");
  });

  it("omits null/absent optionals instead of inventing local defaults", () => {
    const record = saasTaskToLocalRecord(
      saasTask({
        description: null,
        priority: null,
        type: null,
        author: null,
        branchName: null,
        verified: null,
        annotatedElementText: null,
      }),
    );
    // `description` is always present (reconstructed default "" when the
    // view hides it as null); the rest stay omit-on-absent.
    expect(record).toHaveProperty("description");
    expect(record).not.toHaveProperty("priority");
    expect(record).not.toHaveProperty("type");
    expect(record).not.toHaveProperty("author");
    expect(record).not.toHaveProperty("branchName");
    expect(record).not.toHaveProperty("verified");
    expect(record).not.toHaveProperty("annotatedElementText");
  });

  it("maps the snake_case status spelling the legacy surface spoke", () => {
    expect(
      saasTaskToLocalRecord(saasTask({ status: "in_progress" })).status,
    ).toBe("in-progress");
  });

  it("keeps a boolean verified verdict, drops an absent one (tri-state by absence)", () => {
    expect(saasTaskToLocalRecord(saasTask({ verified: true })).verified).toBe(
      true,
    );
    expect(
      saasTaskToLocalRecord(saasTask({ verified: false })).verified,
    ).toBe(false);
    expect(saasTaskToLocalRecord(saasTask())).not.toHaveProperty("verified");
  });

  it("carries links verbatim (unknown keys on the entry survive)", () => {
    const record = saasTaskToLocalRecord(
      saasTask({
        links: [
          { taskId: "parent-1", type: "parent" },
          { taskId: "rel-2", type: "relates" },
        ],
      }),
    );
    expect(record.links).toEqual([
      { taskId: "parent-1", type: "parent" },
      { taskId: "rel-2", type: "relates" },
    ]);
  });

  it("omits an empty link set (never writes links: [])", () => {
    expect(saasTaskToLocalRecord(saasTask({ links: [] }))).not.toHaveProperty(
      "links",
    );
  });

  it("maps v0 comments back onto the local shape (text, not body)", () => {
    const record = saasTaskToLocalRecord(
      saasTask({
        // SAFETY: v0 comment rows are contract JSON the SaasTask comment
        // type does not fully name; the cast only feeds the mapper input.
        comments: [
          {
            id: "c1",
            author: "agent",
            text: "note",
            createdAt: "2026-10-22T10:01:00.000Z",
          },
        ] as unknown as SaasTask["comments"],
      }),
    );
    expect(record.comments).toEqual([
      {
        id: "c1",
        author: "agent",
        text: "note",
        createdAt: "2026-10-22T10:01:00.000Z",
      },
    ]);
  });

  it("maps v0 file rows onto local refs without inventing a mimeType", () => {
    const record = saasTaskToLocalRecord(
      saasTask({
        // SAFETY: same contract-JSON reasoning as the comments test above.
        files: [
          { name: "notes.md", size: 12, system: true },
        ] as unknown as SaasTask["files"],
      }),
    );
    expect(record.files).toEqual([
      { name: "notes.md", addedAt: "2026-10-22T10:00:00.000Z", system: true },
    ]);
  });

  it("keeps a server-minted sortKey when the response carries one", () => {
    const record = saasTaskToLocalRecord(
      // SAFETY: sortKey is a forward-tolerant extra key outside the
      // SaasTask interface; the test proves the mapper honours it.
      saasTask({ sortKey: "0000000009999999" } as unknown as SaasTask),
    );
    expect(record.sortKey).toBe("0000000009999999");
  });
});

describe("extractAcceptedRecord", () => {
  it("prefers the explicit `record` member verbatim (no mapper defaults)", () => {
    const accepted = {
      id: "abc123def456abc123def456abc12345",
      title: "Accepted task",
      status: "todo",
    };
    const { record, exact } = extractAcceptedRecord(
      saasTask({ record: accepted } as unknown as Partial<SaasTask>),
    );
    expect(exact).toBe(true);
    expect(record).toEqual(accepted);
    // No invented defaults on the exact path: the mapper would have forced
    // description "", selector "/", comments [] and files [].
    expect(record).not.toHaveProperty("description");
    expect(record).not.toHaveProperty("selector");
    expect(record).not.toHaveProperty("comments");
    expect(record).not.toHaveProperty("files");
  });

  it("rejects a non-object `record` member and falls back to the mapper", () => {
    const { record, exact } = extractAcceptedRecord(
      saasTask({ record: "nope" } as unknown as Partial<SaasTask>),
    );
    expect(exact).toBe(false);
    expect(record.id).toBe("abc123def456abc123def456abc12345");
  });

  it("falls back to the mapper when the member is absent (older server)", () => {
    const { record, exact } = extractAcceptedRecord(saasTask());
    expect(exact).toBe(false);
    expect(record.description).toBe("");
    expect(record.selector).toBe("/");
  });
});

describe("writeOnlineClone", () => {
  it("writes the clone under the date subdir and returns its path", () => {
    const projectDir = freshDir("clone-write-");
    const filePath = writeOnlineClone(projectDir, saasTask());
    expect(filePath).toBe(
      join(
        projectDir,
        ".vibeflow",
        "tasks",
        "2026-10-22",
        "abc123def456abc123def456abc12345.json",
      ),
    );
    expect(existsSync(filePath)).toBe(true);
    const stored = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(stored.id).toBe("abc123def456abc123def456abc12345");
    expect(stored.title).toBe("Accepted task");
    expect(typeof stored.sortKey).toBe("string");
  });

  it("creates the store dirs when the project has no local store yet", () => {
    const projectDir = freshDir("clone-nostore-");
    expect(existsSync(join(projectDir, ".vibeflow"))).toBe(false);
    writeOnlineClone(projectDir, saasTask());
    expect(
      existsSync(
        join(
          projectDir,
          ".vibeflow",
          "tasks",
          "2026-10-22",
          "abc123def456abc123def456abc12345.json",
        ),
      ),
    ).toBe(true);
  });

  it("persists an accepted `record` verbatim, adding only sortKey + created", () => {
    const projectDir = freshDir("clone-exact-");
    const accepted = {
      id: "abc123def456abc123def456abc12345",
      title: "Accepted task",
      status: "todo",
    };
    const filePath = writeOnlineClone(
      projectDir,
      saasTask({ record: accepted } as unknown as Partial<SaasTask>),
    );
    const stored = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    // Verbatim: every accepted key survives byte-equal; only the two
    // load-bearing local keys are added (raw carries neither).
    expect(stored.title).toBe("Accepted task");
    expect(stored.status).toBe("todo");
    expect(typeof stored.sortKey).toBe("string");
    expect(stored.created).toBe("2026-10-22T10:00:00.000Z");
    expect(stored).not.toHaveProperty("description");
    expect(stored).not.toHaveProperty("selector");
    const { sortKey: _sk, created: _c, ...rest } = stored;
    expect(rest).toEqual(accepted);
  });

  it("warns loudly when the server sent no `record` member (reconstructed clone)", () => {
    const projectDir = freshDir("clone-fallback-");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeOnlineClone(projectDir, saasTask());
      expect(err).toHaveBeenCalledTimes(1);
      const msg = String(err.mock.calls[0]?.[0] ?? "");
      expect(msg).toMatch(/RECONSTRUCTED/);
      expect(msg).toMatch(/pull/);
    } finally {
      err.mockRestore();
    }
  });

  it("stays silent when the accepted `record` member is present", () => {
    const projectDir = freshDir("clone-quiet-");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeOnlineClone(
        projectDir,
        saasTask({
          record: { id: "abc123def456abc123def456abc12345", title: "T" },
        } as unknown as Partial<SaasTask>),
      );
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("mints the sortKey above the store ceiling so the next create stays ordered", async () => {
    const projectDir = freshDir("clone-ceiling-");
    writeOnlineClone(projectDir, saasTask());
    const { createTask } = await import("../../../src/core/tasks.js");
    const next = createTask(projectDir, {
      title: "Local after clone",
      description: "",
      status: "todo",
      selector: "/",
    });
    const clone = JSON.parse(
      readFileSync(
        join(
          projectDir,
          ".vibeflow",
          "tasks",
          "2026-10-22",
          "abc123def456abc123def456abc12345.json",
        ),
        "utf-8",
      ),
    ) as { sortKey: string };
    expect(typeof next.sortKey).toBe("string");
    expect((next.sortKey as string) > clone.sortKey).toBe(true);
  });
});
