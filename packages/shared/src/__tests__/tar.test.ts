import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { readTarEntries, writeTar, type TarInput } from "../tar";

/** A path >100 chars whose only valid split leaves both `name` ≤100 and `prefix` ≤155. */
const LONG_PATH = `${"nested/".repeat(15)}${"file-".repeat(10)}name.txt`;

describe("tar round-trip", () => {
  it("writes three entries (long path + empty file) and reads them back byte-for-byte", async () => {
    expect(LONG_PATH.length).toBeGreaterThan(100);

    const inputs: TarInput[] = [
      { path: "readme.txt", data: Buffer.from("hello tar\n") },
      { path: LONG_PATH, data: Buffer.from("payload for the long path") },
      { path: "empty.bin", data: new Uint8Array(0) },
    ];

    const archive = writeTar(inputs);
    expect(archive.length % 512).toBe(0);

    const readBack: { path: string; size: number; bytes: Buffer }[] = [];
    for await (const entry of readTarEntries(Readable.from([archive]))) {
      const chunks: Buffer[] = [];
      for await (const chunk of entry.stream) {
        chunks.push(Buffer.from(chunk));
      }
      readBack.push({ path: entry.path, size: entry.size, bytes: Buffer.concat(chunks) });
    }

    expect(readBack.map((entry) => entry.path)).toEqual(
      inputs.map((entry) => entry.path),
    );
    expect(readBack.map((entry) => entry.size)).toEqual(
      inputs.map((entry) => entry.data.length),
    );
    expect(readBack.map((entry) => entry.bytes)).toEqual(
      inputs.map((entry) => Buffer.from(entry.data)),
    );
    // Every field — including the prefix/name split of the long path — was
    // reassembled verbatim, and the archive stays block-aligned.
    expect(readBack[1].path).toBe(LONG_PATH);
    expect(archive.length % 512).toBe(0);
  });
});
