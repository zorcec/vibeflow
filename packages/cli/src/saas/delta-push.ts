/**
 * Delta-push client (delta-import plan 2129c1b7).
 *
 * WHAT: the two HTTP seams of the lossless delta push — a capability probe
 * (`GET /api/v0/tasks/import/inventory`) and the archive sender
 * (`POST /api/v0/tasks/import/archive?boardId=…`, one gzipped ustar chunk
 * per request). Plan building (`buildDeltaPlan`/`chunkDeltaPlan`) and tar
 * writing (`writeTar`) already exist; this module only serialises a
 * pre-chunked plan onto the wire.
 *
 * WHY the probe reads the BODY, not the status: the inventory path is
 * PREFIX-MATCHED by old servers — a 200 there can be a foreign handler's
 * answer (`{ items, nextCursor }` from the import preflight, HTML from a
 * catch-all). `deltaImport === 1` is the server's explicit in-body
 * capability sentinel; anything else, any non-2xx, and any transport
 * failure reads as `supported: false` so the caller falls back to the
 * legacy push. The probe NEVER throws — a dead server must not brick push.
 *
 * WHY the sender stops on the first non-2xx: chunks are sequential writes
 * against one quota; after a 402 STORAGE_LIMIT (zero writes server-side)
 * or a 401 the remaining chunks would fail the same way. Fail-fast hands
 * the honest `{ failedChunk, status, body }` back and the caller decides —
 * no retries, no pacing, no local-store access, no output here. This
 * module is transport only: return values in, bytes out.
 */
import { gzipSync } from "node:zlib";
import type { DeltaPlan } from "./delta-archive";
import { parentLinkTargets, recordForWire } from "./batch-push";
import { writeTar, type TarInput } from "./tar-write";

/** Base URL path of the archive endpoint (the v0 wire spelling). */
const ARCHIVE_PATH = "/api/v0/tasks/import/archive";

/** Body-path prefix of the inventory probe. */
const INVENTORY_PATH = "/api/v0/tasks/import/inventory";

/** Response-body cap returned to callers: enough to render a refusal,
 * not enough to buffer a whole error page. */
const MAX_RESULT_BODY_CHARS = 500;

export interface DeltaCapability {
  supported: boolean;
}

/**
 * `GET <apiUrl>/api/v0/tasks/import/inventory` — does this server speak
 * the delta-import contract? True ONLY when a 2xx body carries the
 * `deltaImport: 1` sentinel; a foreign 200 body (old prefix-matching
 * server), any 4xx/5xx (404/405/500 included), an unparseable body, and
 * a transport throw all answer `{ supported: false }` — never a throw.
 */
export async function probeDeltaCapability(args: {
  apiUrl: string;
  token: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<DeltaCapability> {
  const fetchImpl = args.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${args.apiUrl}${INVENTORY_PATH}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${args.token}`, ...args.headers },
    });
    if (!res.ok) return { supported: false };
    const body = (await res.json()) as { deltaImport?: unknown };
    return { supported: body?.deltaImport === 1 };
  } catch {
    return { supported: false };
  }
}

export interface SendDeltaArgs {
  apiUrl: string;
  token: string;
  headers: Record<string, string>;
  boardId: string;
  /** Already chunked by the caller (via `chunkDeltaPlan`). */
  chunks: DeltaPlan[];
  fetchImpl?: typeof fetch;
}

export interface SendDeltaResult {
  ok: boolean;
  sentChunks: number;
  failedChunk: number | null;
  status: number | null;
  body: string;
}

/**
 * Build this task's manifest file list and its archive entries together.
 *
 * A REF must be unique across the WHOLE request: both import routes refuse a
 * repeated `files[].ref` as an INVALID_BODY caller bug. It must therefore never
 * be derived from a filename — names are only unique WITHIN a task
 * (`verify-after.json` exists on 26 real tasks), and an ordinal inserted into
 * the name can collide with a legitimately nested name (`2/image.png`). The ref
 * is an opaque key the server never parses, so it is simply
 * `<taskId>#<index>`: task ids are unique and the index is unique within a
 * task, which makes the pair unique in the request by construction.
 *
 * A name repeated inside ONE task is COLLAPSED to a single entry. The local
 * store is a filesystem (`.vibeflow/files/<taskId>/<name>`), so two files with
 * the same name cannot both exist there; a record that lists the name twice is
 * a corrupt record, and the archive path `files/<taskId>/<name>` would make the
 * server overwrite one payload with the other — silent byte corruption. One
 * entry per name means the archive can never contain two different payloads at
 * the same path.
 */
function declareTaskFiles(task: DeltaPlan["tasks"][number]): {
  manifest: Array<{ ref: string; name: string; system?: true }>;
  payloads: TarInput[];
} {
  const manifest: Array<{ ref: string; name: string; system?: true }> = [];
  const payloads: TarInput[] = [];
  const seenNames = new Set<string>();
  for (const file of task.files) {
    // Empty data = the planner dropped bytes the server already holds; the
    // marker must not travel (the server reports it as MISSING_FILE).
    if (file.data.length === 0) continue;
    if (seenNames.has(file.name)) continue;
    seenNames.add(file.name);
    manifest.push({
      ref: `${task.id}#${manifest.length}`,
      name: file.name,
      ...(file.system === true ? { system: true as const } : {}),
    });
    payloads.push({ path: `files/${task.id}/${file.name}`, data: file.data });
  }
  return { manifest, payloads };
}

/**
 * Serialise one delta-plan chunk as the archive the server expects:
 * `tasks/<id>.json` holds the task's `raw` verbatim (the exact JSON the local
 * store holds — the server re-hashes these bytes against the inventory), and
 * `files/<id>/<name>` holds raw file bytes. Entries whose `data` is empty are
 * SKIPPED: `buildDeltaPlan` marks files the server already holds by dropping
 * their bytes, and the server refuses a declared-but-byteless file as
 * MISSING_FILE — so the marker must not travel.
 */
function chunkToTarEntries(chunk: DeltaPlan): TarInput[] {
  const entries: TarInput[] = [];
  for (const task of chunk.tasks) {
    // The archive route reads `tasks/<id>.json` as the SAME manifest entry the
    // multipart route accepts — not a bare record. It validates that
    // `clientId` equals the id in the path, so a bare record is refused with
    // `declares clientId null` (measured against production).
    const wire = recordForWire(task.raw as Record<string, unknown>);
    const { manifest, payloads } = declareTaskFiles(task);
    entries.push({
      path: `tasks/${task.id}.json`,
      data: Buffer.from(
        JSON.stringify({
          clientId: task.id,
          record: wire,
          fields: wire,
          parentClientIds: parentLinkTargets(wire),
          files: manifest,
        }),
        "utf8",
      ),
    });
    entries.push(...payloads);
  }
  return entries;
}

/**
 * POST every chunk as one gzipped tar, in order. On the FIRST non-2xx the
 * loop stops — later chunks are never sent — and answers
 * `{ ok: false, failedChunk: <index>, status, body }` with the response
 * body text (truncated to 500 chars). A 402 is not special-cased and not
 * retried: this module retries nothing. Transport throws propagate
 * (there is no partial-success shape for a dead connection).
 */
export async function sendDeltaArchive(
  args: SendDeltaArgs,
): Promise<SendDeltaResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `${args.apiUrl}${ARCHIVE_PATH}?boardId=${encodeURIComponent(args.boardId)}`;
  let sentChunks = 0;
  for (let i = 0; i < args.chunks.length; i++) {
    const payload = gzipSync(writeTar(chunkToTarEntries(args.chunks[i]!)));
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.token}`,
        ...args.headers,
        "content-type": "application/gzip",
      },
      body: payload,
    });
    if (!res.ok) {
      return {
        ok: false,
        sentChunks,
        failedChunk: i,
        status: res.status,
        body: (await res.text()).slice(0, MAX_RESULT_BODY_CHARS),
      };
    }
    sentChunks++;
  }
  return { ok: true, sentChunks, failedChunk: null, status: null, body: "" };
}
