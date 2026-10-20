import { describe, it, expect } from "vitest";
import { writeTar, type TarInput } from "../../../src/saas/tar-write.js";

const BLOCK = 512;

interface ParsedEntry {
  path: string;
  size: number;
  mode: string;
  typeflag: string;
  magic: string;
  version: string;
  uname: string;
  gname: string;
  data: Uint8Array;
}

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function readOctal(block: Buffer, offset: number, length: number): number {
  return parseInt(readString(block, offset, length).trim() || "0", 8);
}

/** Compute the ustar checksum over a header block (checksum field as spaces). */
function expectedChecksum(block: Buffer): number {
  const copy = Buffer.from(block);
  copy.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of copy) sum += byte;
  return sum;
}

/** Minimal local ustar reader used only by this test. */
function readTar(buffer: Buffer): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    offset += BLOCK;

    const storedChecksum = readOctal(header, 148, 8);
    expect(storedChecksum).toBe(expectedChecksum(header));

    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      size,
      mode: readString(header, 100, 8),
      typeflag: header.subarray(156, 157).toString("ascii"),
      magic: readString(header, 257, 6),
      version: readString(header, 263, 2),
      uname: readString(header, 265, 32),
      gname: readString(header, 297, 32),
      data: Uint8Array.from(data),
    });
  }
  return entries;
}

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

describe("writeTar", () => {
  it("writes a single small file", () => {
    const data = bytes("hello tar");
    const buffer = writeTar([{ path: "a.txt", data }]);
    const entries = readTar(buffer);

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("a.txt");
    expect(entries[0].size).toBe(data.length);
    expect(entries[0].data).toEqual(data);
    expect(entries[0].magic).toBe("ustar");
    expect(entries[0].version).toBe("00");
    expect(entries[0].typeflag).toBe("0");
    expect(entries[0].mode.trim()).toBe("0000644");
    expect(entries[0].uname).toBe("");
    expect(entries[0].gname).toBe("");
  });

  it("writes two files of differing sizes", () => {
    const small = bytes("abc");
    const large = new Uint8Array(1000);
    large.fill(7);
    const buffer = writeTar([
      { path: "small.bin", data: small },
      { path: "large.bin", data: large },
    ]);
    const entries = readTar(buffer);

    expect(entries.map((e) => e.path)).toEqual(["small.bin", "large.bin"]);
    expect(entries[0].data).toEqual(small);
    expect(entries[1].data).toEqual(large);
    expect(entries[1].size).toBe(1000);
  });

  it("splits a long path into prefix and name", () => {
    const dir =
      "deeply/nested/directory/structure/with/many/levels/of/folders/and/more/extra-segment";
    const path = `${dir}/file-with-a-long-name.txt`;
    expect(path.length).toBeGreaterThan(100);
    const data = bytes("long path payload");
    const buffer = writeTar([{ path, data }]);
    const entries = readTar(buffer);

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe(path);
    expect(entries[0].data).toEqual(data);

    // The header must actually use the prefix field.
    const header = buffer.subarray(0, BLOCK);
    expect(readString(header, 345, 155)).toBe(dir);
    expect(readString(header, 0, 100)).toBe("file-with-a-long-name.txt");
  });

  it("writes an empty file", () => {
    const buffer = writeTar([{ path: "empty.txt", data: new Uint8Array(0) }]);
    const entries = readTar(buffer);

    expect(entries).toHaveLength(1);
    expect(entries[0].size).toBe(0);
    expect(entries[0].data).toHaveLength(0);
    expect(buffer.length).toBe(BLOCK * 3);
  });

  it("emits a 512-aligned buffer terminated by two zero blocks", () => {
    const entries: TarInput[] = [
      { path: "one.txt", data: bytes("12345") },
      { path: "two.txt", data: new Uint8Array(600) },
    ];
    const buffer = writeTar(entries);

    expect(buffer.length % BLOCK).toBe(0);
    expect(buffer.subarray(buffer.length - BLOCK * 2).every((b) => b === 0)).toBe(
      true,
    );
    expect(buffer.subarray(buffer.length - BLOCK * 2 - 1).every((b) => b === 0)).toBe(
      true,
    );
  });

  it("rejects paths containing '..' segments", () => {
    expect(() =>
      writeTar([{ path: "a/../b.txt", data: bytes("x") }]),
    ).toThrow(/\.\./);
  });

  it("rejects absolute paths", () => {
    expect(() =>
      writeTar([{ path: "/etc/passwd", data: bytes("x") }]),
    ).toThrow(/relative/);
  });

  it("rejects paths longer than 255 bytes", () => {
    const path = `${"x".repeat(260)}.txt`;
    expect(() => writeTar([{ path, data: bytes("x") }])).toThrow(/exceeds/);
  });
});
