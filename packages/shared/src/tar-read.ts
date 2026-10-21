/**
 * Minimal in-repo ustar (POSIX tar) reader.
 *
 * WHY this exists: the import route must consume an uploaded archive without
 * pulling in a tar dependency, and — more importantly — without trusting the
 * archive. Every limit below is enforced against the ACTUAL bytes read, never
 * against the size field a header claims, and the reader never buffers a whole
 * entry: content is pushed to the caller through a stream bound to the entry
 * size.
 *
 * Supported: regular files (`0` / `\0`) and directories (`5`, skipped).
 * Rejected loudly: absolute paths, `..` path traversal, pax/GNU extended
 * headers (`x`, `g`, `L`, `K`), any other type flag, bad header checksums,
 * truncated archives, and archives exceeding the configured caps.
 */
import { Readable } from "node:stream";

export interface TarEntry {
  /** Path of the entry inside the archive (never absolute, never contains `..`). */
  path: string;
  /** Size declared by the header; the entry stream is bound to exactly this many bytes. */
  size: number;
  /** Readable stream over the entry content. */
  stream: NodeJS.ReadableStream;
}

export interface ReadTarEntriesOptions {
  /** Maximum number of headers (files + directories) accepted. Default 1000. */
  maxEntries?: number;
  /** Maximum payload bytes for a single entry. Default 5 MiB. */
  maxEntryBytes?: number;
  /** Maximum payload bytes across all entries. Default 100 MiB. */
  maxTotalBytes?: number;
}

const BLOCK_SIZE = 512;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** Header field offsets (bytes within the 512-byte header block). */
const OFF_NAME = 0;
const OFF_SIZE = 124;
const OFF_CHECKSUM = 148;
const OFF_TYPEFLAG = 156;
const OFF_MAGIC = 257;
const OFF_PREFIX = 345;

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.toString("utf8", 0, nul === -1 ? slice.length : nul);
}

/** Parses a NUL/space padded octal header field. */
function parseOctal(field: Buffer, label: string): number {
  const text = field.toString("latin1").replace(/\0/g, " ").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`invalid tar header: ${label} is not an octal number`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid tar header: ${label} is out of range`);
  }
  return value;
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/** ustar checksum: sum of all header bytes with the checksum field read as spaces. */
function checksumMatches(block: Buffer, expected: number): boolean {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    const byte = i >= OFF_CHECKSUM && i < OFF_CHECKSUM + 8 ? 0x20 : block[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return unsigned === expected || signed === expected;
}

function assertSafePath(path: string): void {
  if (path.startsWith("/")) {
    throw new Error(`tar entry path is absolute: ${path}`);
  }
  if (path.split("/").includes("..")) {
    throw new Error(`tar entry path escapes the archive root: ${path}`);
  }
}

/**
 * Serialized byte source over the input stream.
 *
 * `readExact` is used for structural reads (headers, padding) where a short
 * read means the archive is truncated. `readAvailable` is used for entry
 * content so bytes are pushed to the caller as they arrive.
 */
class TarSource {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  private finished = false;
  private lock: Promise<void> = Promise.resolve();

  constructor(source: NodeJS.ReadableStream) {
    // SAFETY: every NodeJS.ReadableStream is a Readable, which is async
    // iterable yielding Buffer|string chunks; the type declaration just does
    // not carry the async iterator symbol.
    const chunks = source as unknown as AsyncIterable<Buffer | string>;
    this.iterator = (async function* iterate() {
      for await (const chunk of chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    })();
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release = (): void => {};
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Returns up to `max` bytes as soon as any are available; empty at EOF. */
  async readAvailable(max: number): Promise<Buffer> {
    if (max <= 0) return Buffer.alloc(0);
    return this.withLock(async () => {
      if (this.pending.length === 0) {
        const next = await this.iterator.next();
        if (next.done) {
          this.finished = true;
          return Buffer.alloc(0);
        }
        this.pending = Buffer.isBuffer(next.value)
          ? next.value
          : Buffer.from(next.value);
      }
      const out = this.pending.subarray(0, Math.min(max, this.pending.length));
      this.pending = this.pending.subarray(out.length);
      return out;
    });
  }

  /** Returns exactly `size` bytes or throws when the archive ends early. */
  async readExact(size: number, what: string): Promise<Buffer> {
    const parts: Buffer[] = [];
    let total = 0;
    while (total < size) {
      const chunk = await this.readAvailable(size - total);
      if (chunk.length === 0) {
        throw new Error(
          `truncated tar archive: expected ${size} bytes of ${what}, got ${total}`,
        );
      }
      parts.push(chunk);
      total += chunk.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, total);
  }

  /** Discards `size` bytes, throwing when the archive ends early. */
  async skipExact(size: number, what: string): Promise<void> {
    await this.readExact(size, what);
  }
}

/**
 * Reads a ustar archive and yields one entry per regular file.
 *
 * Directory entries are skipped. Content is never buffered by the reader: each
 * entry is handed over as a stream bound to the header size, and the padding up
 * to the next 512-byte boundary is consumed once the caller moves on.
 */
export async function* readTarEntries(
  source: NodeJS.ReadableStream,
  opts: ReadTarEntriesOptions = {},
): AsyncIterable<TarEntry> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const reader = new TarSource(source);
  let headerCount = 0;
  let totalBytes = 0;

  for (;;) {
    const header = await reader.readExact(BLOCK_SIZE, "header block");
    if (isZeroBlock(header)) {
      const marker = await reader.readExact(BLOCK_SIZE, "end-of-archive marker");
      if (!isZeroBlock(marker)) {
        throw new Error("invalid tar archive: expected end-of-archive marker");
      }
      return;
    }

    headerCount += 1;
    if (headerCount > maxEntries) {
      throw new Error(`tar archive exceeds maxEntries limit of ${maxEntries}`);
    }

    const name = readString(header, OFF_NAME, 100);
    const prefix = readString(header, OFF_PREFIX, 155);
    const path = prefix ? `${prefix}/${name}` : name;

    const expectedChecksum = parseOctal(
      header.subarray(OFF_CHECKSUM, OFF_CHECKSUM + 8),
      "checksum",
    );
    if (!checksumMatches(header, expectedChecksum)) {
      throw new Error(`tar header checksum mismatch for entry ${path}`);
    }

    const size = parseOctal(header.subarray(OFF_SIZE, OFF_SIZE + 12), "size");
    const typeflag = String.fromCharCode(header[OFF_TYPEFLAG]);
    const magic = readString(header, OFF_MAGIC, 6);

    if (magic !== "" && magic !== "ustar") {
      throw new Error(`unsupported tar format: magic ${JSON.stringify(magic)}`);
    }

    if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K") {
      throw new Error(
        `unsupported tar extended header (type flag ${JSON.stringify(typeflag)}) for entry ${path}`,
      );
    }

    const isFile = typeflag === "0" || typeflag === "\0";
    const isDirectory = typeflag === "5";
    if (!isFile && !isDirectory) {
      throw new Error(
        `unsupported tar type flag ${JSON.stringify(typeflag)} for entry ${path}`,
      );
    }

    if (path === "") {
      throw new Error("invalid tar header: empty entry name");
    }
    assertSafePath(path);

    if (isDirectory) {
      // Directories carry no payload; skip whatever they claim and their padding.
      if (size > 0) await reader.skipExact(size, `directory ${path}`);
      const pad = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
      if (pad > 0) await reader.skipExact(pad, `padding for ${path}`);
      continue;
    }

    let entryBytes = 0;
    let remaining = size;
    let pendingRead = false;
    let ended = false;
    let failure: Error | null = null;

    /** Counts actual payload bytes and enforces the byte caps. */
    const account = (count: number): void => {
      entryBytes += count;
      totalBytes += count;
      if (entryBytes > maxEntryBytes) {
        throw new Error(
          `tar entry ${path} exceeds maxEntryBytes limit of ${maxEntryBytes} bytes`,
        );
      }
      if (totalBytes > maxTotalBytes) {
        throw new Error(
          `tar archive exceeds maxTotalBytes limit of ${maxTotalBytes} bytes`,
        );
      }
    };

    const stream = new Readable({
      read(this: Readable) {
        if (ended) return;
        if (remaining <= 0) {
          ended = true;
          this.push(null);
          return;
        }
        if (pendingRead) return;
        pendingRead = true;
        void (async () => {
          try {
            const chunk = await reader.readAvailable(remaining);
            if (chunk.length === 0) {
              throw new Error(
                `truncated tar archive: entry ${path} ended before ${size} bytes`,
              );
            }
            remaining -= chunk.length;
            account(chunk.length);
            this.push(chunk);
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            this.destroy(failure);
          } finally {
            pendingRead = false;
          }
        })();
      },
    });

    yield { path, size, stream };

    // The caller may have stopped reading early: pull the rest of the entry out
    // of the source and hand it to the stream, so the archive framing stays
    // aligned and a late consumer still receives the whole entry.
    if (remaining > 0) {
      const chunk = await reader.readExact(remaining, `entry ${path}`);
      remaining = 0;
      try {
        account(chunk.length);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        stream.destroy(failure);
        throw failure;
      }
      if (!stream.destroyed && !ended) {
        ended = true;
        stream.push(chunk);
        stream.push(null);
      }
    }
    if (failure) throw failure;

    const pad = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
    if (pad > 0) await reader.skipExact(pad, `padding for ${path}`);
  }
}
