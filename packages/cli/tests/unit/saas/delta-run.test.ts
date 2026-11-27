import { gunzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { hashTaskRecord } from "@vibeflow-tools/shared/delta-hash";
import {
  DELTA_CHUNK_MAX_INPUT_BYTES,
  DELTA_CHUNK_MAX_TASKS,
  INVENTORY_MAX_PAGES,
  fetchInventory,
  runDeltaPush,
} from "../../../src/saas/delta-run";
import { chunkDeltaPlan } from "../../../src/saas/delta-archive";
import type { ImportTaskInput } from "../../../src/saas/batch-push";

const API = "https://api.test";
const BOARD = "board-1";
const HEADERS = { "X-Vibeflow-Scope": BOARD };

const dir = mkdtempSync(join(tmpdir(), "vf-delta-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function localInput(id: string, record: Record<string, unknown>, files: { name: string; body: string }[] = []): ImportTaskInput {
  return {
    localId: id,
    record,
    files: files.map((f, i) => {
      const filePath = join(dir, `${id}-${i}-${f.name}`);
      writeFileSync(filePath, f.body);
      return { name: f.name, filePath, size: f.body.length, system: false };
    }),
  };
}

interface Call { url: string; method: string; body?: Uint8Array }

/**
 * Minimal stand-in for the two routes. `pages` is keyed by the cursor the
 * client sends (null for the first page), so pagination is exercised for real
 * rather than assumed.
 */
function fakeServer(opts: {
  pages: Record<string, unknown>;
  archiveStatus?: number;
}) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as Uint8Array | undefined });

    if (url.includes("/import/archive")) {
      const status = opts.archiveStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { ok: true } : { code: "STORAGE_LIMIT" }), {
        status,
      });
    }
    const cursor = new URL(url).searchParams.get("cursor");
    const key = cursor === null ? "null" : cursor;
    const page = opts.pages[key];
    if (page === undefined) throw new Error(`unexpected inventory cursor ${key}`);
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const archives = (calls: Call[]) => calls.filter((c) => c.url.includes("/import/archive"));
const inventories = (calls: Call[]) => calls.filter((c) => c.url.includes("/import/inventory"));

describe("runDeltaPush", () => {
  it("falls back (returns null) when the board has no inventory route", async () => {
    const record = { id: "t1", title: "a" };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ tasks: [] }), { status: 200 })) as unknown as typeof fetch;
    const result = await runDeltaPush(API, "tok", BOARD, [localInput("t1", record)], {
      headers: HEADERS,
      fetchImpl,
      emails: new Map(),
    });
    expect(result).toBeNull();
  });

  it("sends NOTHING when the board already matches (converged push)", async () => {
    const record = { id: "t1", title: "a" };
    const { impl, calls } = fakeServer({
      pages: { null: { deltaImport: 1, tasks: [{ id: "t1", hash: hashTaskRecord(record) }], files: [], nextCursor: null } },
    });
    const result = await runDeltaPush(API, "tok", BOARD, [localInput("t1", record)], {
      headers: HEADERS,
      fetchImpl: impl,
      emails: new Map(),
    });
    expect(result).toMatchObject({ imported: 0, unchanged: 1, chunks: 0 });
    expect(archives(calls)).toHaveLength(0);
  });

  it("follows nextCursor across pages before deciding", async () => {
    const r1 = { id: "t1", title: "a" };
    const r2 = { id: "t2", title: "b" };
    const { impl, calls } = fakeServer({
      pages: {
        null: { deltaImport: 1, tasks: [{ id: "t1", hash: hashTaskRecord(r1) }], files: [], nextCursor: "t1" },
        t1: { deltaImport: 1, tasks: [{ id: "t2", hash: hashTaskRecord(r2) }], files: [], nextCursor: null },
      },
    });
    const result = await runDeltaPush(
      API,
      "tok",
      BOARD,
      [localInput("t1", r1), localInput("t2", r2)],
      { headers: HEADERS, fetchImpl: impl, emails: new Map() },
    );
    expect(result).toMatchObject({ imported: 0, unchanged: 2 });
    // probe + first page + second page = 3 inventory GETs, zero archives.
    expect(inventories(calls).length).toBeGreaterThanOrEqual(3);
    expect(archives(calls)).toHaveLength(0);
  });

  it("counts the files it actually archived: one non-empty plus one 0-byte file (ticket sxz694mdftq)", async () => {
    // The summary (`filesSent`) and the archive are one fact. The writer used
    // to drop every empty payload — including a real 0-byte file — while the
    // count included it, so a partial push reported success with N when the
    // board got N-1.
    const record = { id: "t1", title: "a" };
    const { impl, calls } = fakeServer({
      pages: { null: { deltaImport: 1, tasks: [], files: [], nextCursor: null } },
    });
    const result = await runDeltaPush(
      API,
      "tok",
      BOARD,
      [
        localInput("t1", record, [
          { name: "note.md", body: "hello" },
          { name: "empty.txt", body: "" },
        ]),
      ],
      { headers: HEADERS, fetchImpl: impl, emails: new Map() },
    );

    // The summary first, then what the receiver actually got — the bug was
    // these two disagreeing.
    expect(result!.filesSent).toBe(2);
    const tar = gunzipSync(Buffer.from(archives(calls)[0]!.body!)).toString("latin1");
    // Each file entry contributes exactly one `files/<task>/` header path.
    expect(tar.split("files/t1/").length - 1).toBe(result!.filesSent);
    expect(tar).toContain("files/t1/empty.txt");
    expect(tar).toContain("files/t1/note.md");
    // The receiver's manifest names exactly the same two files.
    expect(tar).toContain('"name":"empty.txt"');
    expect(tar).toContain('"name":"note.md"');
  });

  it("forces a task whose RECORD matches but whose file the board cannot prove it has", async () => {
    const record = { id: "t1", title: "a" };
    const { impl, calls } = fakeServer({
      pages: {
        null: {
          deltaImport: 1,
          // record hash identical; file list empty => unknown file
          tasks: [{ id: "t1", hash: hashTaskRecord(record) }],
          files: [],
          nextCursor: null,
        },
      },
    });
    const result = await runDeltaPush(
      API,
      "tok",
      BOARD,
      [localInput("t1", record, [{ name: "shot.png", body: "PNGDATA" }])],
      { headers: HEADERS, fetchImpl: impl, emails: new Map() },
    );
    expect(result).toMatchObject({ imported: 1 });
    expect(archives(calls)).toHaveLength(1);
    const tar = gunzipSync(Buffer.from(archives(calls)[0]!.body!)).toString("latin1");
    expect(tar).toContain("files/t1/shot.png");
    expect(tar).toContain("PNGDATA");
  });

  it("injects authorEmail into the wire record only (local data untouched)", async () => {
    const record = { id: "t1", title: "a", commits: [{ sha: "0123456789abcdef0123456789abcdef01234567" }] };
    const before = JSON.stringify(record);
    const { impl, calls } = fakeServer({
      pages: { null: { deltaImport: 1, tasks: [], files: [], nextCursor: null } },
    });
    await runDeltaPush(API, "tok", BOARD, [localInput("t1", record)], {
      headers: HEADERS,
      fetchImpl: impl,
      emails: new Map([["0123456789abcdef0123456789abcdef01234567", "author@example.test"]]),
    });
    const tar = gunzipSync(Buffer.from(archives(calls)[0]!.body!)).toString("latin1");
    expect(tar).toContain("author@example.test");
    // the caller's object is not mutated
    expect(JSON.stringify(record)).toBe(before);
  });

  it("rejects on a storage refusal and never retries another chunk", async () => {
    const record = { id: "t1", title: "a" };
    let archiveCalls = 0;
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/import/archive")) {
        archiveCalls += 1;
        return new Response(JSON.stringify({ code: "STORAGE_LIMIT" }), { status: 402 });
      }
      return new Response(
        JSON.stringify({ deltaImport: 1, tasks: [], files: [], nextCursor: null }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await expect(
      runDeltaPush(API, "tok", BOARD, [localInput("t1", record)], {
        headers: HEADERS,
        fetchImpl: impl,
        emails: new Map(),
      }),
    ).rejects.toThrow(/STORAGE_LIMIT|402/);
    expect(archiveCalls).toBe(1);
  });
});

describe("inventory pagination stalls (ticket nt31gdmx)", () => {
  /** A board that answers every page from `pageFor(cursor)`, counting GETs. */
  function inventoryDouble(pageFor: (cursor: string | null) => unknown) {
    const calls: Call[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      const cursor = new URL(url).searchParams.get("cursor");
      return new Response(JSON.stringify(pageFor(cursor)), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("fails loudly on a non-advancing cursor instead of re-reading it", async () => {
    // The server always answers the SAME next cursor — the exact stall that
    // used to burn the whole 10,000-page cap and then return a partial board.
    const { impl, calls } = inventoryDouble(() => ({
      deltaImport: 1,
      tasks: [{ id: "t1", hash: "h1" }],
      files: [],
      nextCursor: "stuck",
    }));

    await expect(
      fetchInventory(API, "tok", BOARD, HEADERS, impl),
    ).rejects.toThrow(/repeated the cursor "stuck"/);
    // Two pages, not the cap: page 1 asks with no cursor, page 2 with "stuck"
    // (which answers "stuck" again and is refused).
    expect(calls).toHaveLength(2);
  });

  it("fails loudly on an empty page that still returns a cursor", async () => {
    const { impl, calls } = inventoryDouble(() => ({
      deltaImport: 1,
      tasks: [],
      files: [],
      nextCursor: "ghost",
    }));

    await expect(fetchInventory(API, "tok", BOARD, HEADERS, impl)).rejects.toThrow(
      /page 1 carried no tasks and no files but returned a cursor \("ghost"\)/,
    );
    expect(calls).toHaveLength(1);
  });

  it("fails loudly at the page cap rather than returning a silent partial inventory", async () => {
    // Distinct, always-new cursors: no stall guard fires, so this exercises
    // the cap path (the last way the old loop could end without a real end).
    const { impl, calls } = inventoryDouble((cursor) => ({
      deltaImport: 1,
      tasks: [],
      files: [{ taskId: "t1", name: `${cursor ?? "first"}.png`, size: 1, hash: null }],
      nextCursor: `${Number(cursor ?? 0) + 1}`,
    }));

    await expect(fetchInventory(API, "tok", BOARD, HEADERS, impl)).rejects.toThrow(
      new RegExp(`hit the ${INVENTORY_MAX_PAGES}-page cap`),
    );
    expect(calls.length).toBe(INVENTORY_MAX_PAGES);
  });

  it("surfaces the stall as a failed push, never as a converged one", async () => {
    const { impl } = inventoryDouble(() => ({
      deltaImport: 1,
      tasks: [{ id: "t1", hash: hashTaskRecord({ id: "t1", title: "a" }) }],
      files: [],
      nextCursor: "stuck",
    }));

    // The probe and the pages share the route; only the pages carry the cursor.
    await expect(
      runDeltaPush(API, "tok", BOARD, [localInput("t1", { id: "t1", title: "a" })], {
        headers: HEADERS,
        fetchImpl: impl,
        emails: new Map(),
      }),
    ).rejects.toThrow(/refusing a partial inventory/);
  });
});

describe("delta chunk sizing vs the server archive cap", () => {  // Guard pin: the archive route (`POST /api/v0/tasks/import/archive`)
  // refuses any request with more than V0_IMPORT_MAX_TASKS (= 100) tasks
  // with 400 BATCH_TOO_LARGE. A future bump of this constant past 100
  // must fail HERE, not as a production push of >100 changed tasks.
  it("pins DELTA_CHUNK_MAX_TASKS at or under the server cap of 100", () => {
    expect(DELTA_CHUNK_MAX_TASKS).toBeLessThanOrEqual(100);
  });

  it("chunks a 123-task plan into <=100-task pieces (live 400 regression)", () => {
    // Live failure: 123 changed tasks in ONE archive answered
    // `400 {"code":"BATCH_TOO_LARGE"}` because the chunker allowed 200.
    const tasks = Array.from({ length: 123 }, (_, i) => ({
      id: `t${i}`,
      raw: { title: `task ${i}` },
      files: [],
    }));
    const chunks = chunkDeltaPlan(
      { tasks, unchangedTaskIds: [], droppedFileCount: 0 },
      DELTA_CHUNK_MAX_TASKS,
      DELTA_CHUNK_MAX_INPUT_BYTES,
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tasks.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.flatMap((chunk) => chunk.tasks.map((t) => t.id))).toEqual(
      tasks.map((t) => t.id),
    );
  });

  it("sends 123 changed tasks as two archive POSTs through runDeltaPush", async () => {
    const inputs = Array.from({ length: 123 }, (_, i) =>
      localInput(`t${i}`, { id: `t${i}`, title: `task ${i}` }),
    );
    const { impl, calls } = fakeServer({
      pages: { null: { deltaImport: 1, tasks: [], files: [], nextCursor: null } },
    });
    const result = await runDeltaPush(API, "tok", BOARD, inputs, {
      headers: HEADERS,
      fetchImpl: impl,
      emails: new Map(),
    });
    expect(result).toMatchObject({ imported: 123, chunks: 2 });
    expect(archives(calls)).toHaveLength(2);
  });
});
