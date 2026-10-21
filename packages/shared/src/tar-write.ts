/**
 * Minimal POSIX ustar (tar) writer.
 *
 * Produces a byte-exact ustar archive: 512-byte header per entry, file data
 * padded to the next 512-byte boundary, and two zero blocks as the archive
 * terminator. No compression, no long-name extension records — the writer
 * rejects anything it cannot represent instead of truncating silently.
 */

const BLOCK_SIZE = 512;

/** Maximum path length representable as `prefix` (155) + `name` (100). */
const MAX_PATH_LENGTH = 255;

/** Maximum file size representable in the 12-byte octal size field (11 digits). */
const MAX_SIZE = 0o77777777777;

/** One file to place into the archive. */
export interface TarInput {
  path: string;
  data: Uint8Array;
}

function writeString(
  block: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(
      `tar: field at offset ${offset} does not fit in ${length} bytes`,
    );
  }
  bytes.copy(block, offset);
}

function writeOctal(
  block: Buffer,
  value: number,
  offset: number,
  length: number,
): void {
  // `length` bytes hold `length - 1` octal digits plus a trailing NUL.
  const digits = value.toString(8).padStart(length - 1, "0");
  if (digits.length > length - 1) {
    throw new Error(`tar: value ${value} does not fit in ${length} bytes`);
  }
  block.write(`${digits}\0`, offset, length, "ascii");
}

/**
 * Split a path into the ustar `prefix` and `name` fields.
 *
 * The split happens at a directory separator so the two parts can be
 * reassembled verbatim; throws when no valid split exists.
 */
function splitPath(path: string): { prefix: string; name: string } {
  if (path.length <= 100) {
    return { prefix: "", name: path };
  }
  if (path.length > MAX_PATH_LENGTH) {
    throw new Error(
      `tar: path exceeds ${MAX_PATH_LENGTH} bytes: ${path.length}`,
    );
  }
  // The `name` field holds at most 100 bytes; find the latest separator
  // that leaves a `name` of at most 100 bytes and a `prefix` of at most 155.
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (name.length > 100 || name.length === 0) continue;
    if (prefix.length > 155 || prefix.length === 0) continue;
    return { prefix, name };
  }
  throw new Error(`tar: path cannot be split into prefix/name: ${path}`);
}

function assertRepresentable(entry: TarInput): void {
  const { path, data } = entry;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("tar: entry path must be a non-empty string");
  }
  if (path.startsWith("/")) {
    throw new Error(`tar: path must be relative: ${path}`);
  }
  const segments = path.split("/");
  if (segments.includes("..")) {
    throw new Error(`tar: path must not contain '..' segments: ${path}`);
  }
  if (path.length > MAX_PATH_LENGTH) {
    throw new Error(
      `tar: path exceeds ${MAX_PATH_LENGTH} bytes: ${path.length}`,
    );
  }
  if (data.length > MAX_SIZE) {
    throw new Error(
      `tar: entry size ${data.length} exceeds the maximum ${MAX_SIZE}`,
    );
  }
}

/** Build the 512-byte ustar header block for one entry. */
function buildHeader(entry: TarInput): Buffer {
  const { prefix, name } = splitPath(entry.path);
  const block = Buffer.alloc(BLOCK_SIZE);

  writeString(block, name, 0, 100);
  writeOctal(block, 0o644, 100, 8); // mode
  writeOctal(block, 0, 108, 8); // uid
  writeOctal(block, 0, 116, 8); // gid
  writeOctal(block, entry.data.length, 124, 12); // size
  writeOctal(block, 0, 136, 12); // mtime
  block.fill(0x20, 148, 156); // checksum placeholder: 8 spaces
  block.write("0", 156, 1, "ascii"); // typeflag: regular file
  block.write("ustar\0", 257, 6, "ascii"); // magic
  block.write("00", 263, 2, "ascii"); // version
  // uname (265..297) and gname (297..329) stay empty.
  writeOctal(block, 0, 329, 8); // devmajor
  writeOctal(block, 0, 337, 8); // devminor
  if (prefix) writeString(block, prefix, 345, 155);

  // Checksum: sum of all header bytes with the checksum field read as spaces.
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

  return block;
}

/**
 * Write a POSIX ustar archive containing `entries`.
 *
 * @throws when an entry path or size cannot be represented in a ustar header.
 */
export function writeTar(entries: TarInput[]): Buffer {
  for (const entry of entries) {
    assertRepresentable(entry);
    splitPath(entry.path); // fail fast on unsplittable paths
  }

  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(buildHeader(entry));
    const data = Buffer.from(entry.data);
    chunks.push(data);
    const remainder = data.length % BLOCK_SIZE;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(BLOCK_SIZE - remainder));
    }
  }
  // Two zero blocks terminate the archive.
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));

  return Buffer.concat(chunks);
}
