import { describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";

import {
  probeDeltaCapability,
  sendDeltaArchive,
} from "../../../src/saas/delta-push";
import type { DeltaPlan, LocalTask } from "../../../src/saas/delta-archive";

const API = "https://api.example.test";
const BLOCK = 512;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/* ── probeDeltaCapability ─────────────────────────────────────────── */

describe("probeDeltaCapability", () => {
  it("reports supported on a 200 carrying the deltaImport sentinel", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ deltaImport: 1 }));
    const result = await probeDeltaCapability({
      apiUrl: API,
      token: "tok",
      headers: { "X-Vibeflow-Scope": "board-1" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ supported: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `${API}/api/v0/tasks/import/inventory`,
    );
  });

  it("reports unsupported on a 200 with a foreign body (old prefix-matching server)", async () => {
    // Old servers answer the inventory path with the import preflight's
    // `{ items, nextCursor }` — 200 but no sentinel.
    const fetchImpl = vi.fn().mockResolvedValue(jsonRes({ tasks: [] }));
    const result = await probeDeltaCapability({
      apiUrl: API,
      token: "tok",
      headers: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ supported: false });
  });

  it("reports unsupported on a 404", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    const result = await probeDeltaCapability({
      apiUrl: API,
      token: "tok",
      headers: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ supported: false });
  });

  it("reports unsupported when the probe throws (dead server)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await probeDeltaCapability({
      apiUrl: API,
      token: "tok",
      headers: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ supported: false });
  });
});

/* ── sendDeltaArchive ─────────────────────────────────────────────── */

function task(id: string, raw: unknown, files: LocalTask["files"] = []): LocalTask {
  return { id, raw, files };
}

function chunk(tasks: LocalTask[]): DeltaPlan {
  return { tasks, unchangedTaskIds: [], droppedFileCount: 0 };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Minimal ustar reader for this test (mirrors tar-write.test.ts). */
interface ParsedEntry {
  path: string;
  size: number;
  data: Uint8Array;
}

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function readTar(buffer: Buffer): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    offset += BLOCK;
    const size = parseInt(readString(header, 124, 12).trim() || "0", 8);
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;
    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    entries.push({ path: prefix ? `${prefix}/${name}` : name, size, data });
  }
  return entries;
}

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function capturingFetch(
  responses: Array<Response | (() => Response | Promise<Response>)>,
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const idx = calls.length;
    const headers = { ...(init?.headers as Record<string, string>) };
    // Body arrives as a Buffer (gzipSync output); copy so later reads are safe.
    const body = new Uint8Array(init?.body as Uint8Array);
    calls.push({ url, headers, body });
    const next = responses[Math.min(idx, responses.length - 1)]!;
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const okRes = (): Response => new Response("{}", { status: 200 });

describe("sendDeltaArchive", () => {
  it("sends one chunk as a gzipped tar with tasks/<id>.json and files/<id>/<name>", async () => {
    const raw = { id: "t1", title: "hello", nested: { z: 1, a: 2 } };
    const { fetchImpl, calls } = capturingFetch([okRes]);

    const result = await sendDeltaArchive({
      apiUrl: API,
      token: "tok",
      headers: { "X-Vibeflow-Scope": "board-1" },
      boardId: "board-1",
      chunks: [
        chunk([
          task("t1", raw, [{ name: "note.md", size: 5, data: bytes("hello") }]),
        ]),
      ],
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      sentChunks: 1,
      failedChunk: null,
      status: null,
      body: "",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${API}/api/v0/tasks/import/archive?boardId=board-1`,
    );
    expect(calls[0]!.headers["content-type"]).toBe("application/gzip");
    expect(calls[0]!.headers["X-Vibeflow-Scope"]).toBe("board-1");

    const entries = readTar(gunzipSync(calls[0]!.body));
    expect(entries.map((e) => e.path)).toEqual([
      "tasks/t1.json",
      "files/t1/note.md",
    ]);
    // The archive route reads this file as the SAME manifest entry the
    // multipart route accepts, not a bare record: it validates
    // `clientId === <id from path>`. Sending the bare record was rejected by
    // PRODUCTION with 400 INVALID_BODY "declares clientId null" — so the
    // entry shape is the contract, and this test pins it.
    const entry = JSON.parse(Buffer.from(entries[0]!.data).toString("utf8"));
    expect(entry.clientId).toBe("t1");
    expect(entry.record).toEqual(raw);
    expect(entry.fields).toEqual(raw);
    expect(entry.files).toEqual([{ ref: "note.md", name: "note.md" }]);
    expect(Buffer.from(entries[1]!.data).toString("utf8")).toBe("hello");
  });

  it("omits dropped files (empty data, size > 0) from the archive", async () => {
    const { fetchImpl, calls } = capturingFetch([okRes]);

    await sendDeltaArchive({
      apiUrl: API,
      token: "tok",
      headers: {},
      boardId: "board-1",
      chunks: [
        chunk([
          task("t1", { id: "t1" }, [
            { name: "dropped.md", size: 42, data: new Uint8Array(0) },
            { name: "kept.md", size: 3, data: bytes("abc") },
          ]),
        ]),
      ],
      fetchImpl,
    });

    const entries = readTar(gunzipSync(calls[0]!.body));
    expect(entries.map((e) => e.path)).toEqual([
      "tasks/t1.json",
      "files/t1/kept.md",
    ]);
  });

  it("stops on the first non-2xx: 402 on chunk 2 of 3, chunk 3 never sent", async () => {
    const longBody = "quota exceeded ".repeat(100); // > 500 chars → truncated
    const { fetchImpl, calls } = capturingFetch([
      okRes,
      () => new Response(longBody, { status: 402 }),
      okRes,
    ]);
    const chunks = [
      chunk([task("t1", { id: "t1" })]),
      chunk([task("t2", { id: "t2" })]),
      chunk([task("t3", { id: "t3" })]),
    ];

    const result = await sendDeltaArchive({
      apiUrl: API,
      token: "tok",
      headers: {},
      boardId: "board-1",
      chunks,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.failedChunk).toBe(1);
    expect(result.sentChunks).toBe(1);
    expect(result.status).toBe(402);
    expect(result.body.length).toBe(500);
    expect(result.body).toBe(longBody.slice(0, 500));
    // Chunk 3 was never attempted.
    expect(calls).toHaveLength(2);
  });

  it("sends every chunk in order on success", async () => {
    const { fetchImpl, calls } = capturingFetch([okRes, okRes]);

    const result = await sendDeltaArchive({
      apiUrl: API,
      token: "tok",
      headers: {},
      boardId: "board-1",
      chunks: [chunk([task("t1", { id: "t1" })]), chunk([task("t2", { id: "t2" })])],
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      sentChunks: 2,
      failedChunk: null,
      status: null,
      body: "",
    });
    expect(calls).toHaveLength(2);
    const first = readTar(gunzipSync(calls[0]!.body));
    const second = readTar(gunzipSync(calls[1]!.body));
    expect(first.map((e) => e.path)).toEqual(["tasks/t1.json"]);
    expect(second.map((e) => e.path)).toEqual(["tasks/t2.json"]);
  });
});
