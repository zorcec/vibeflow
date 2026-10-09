import { describe, it, expect } from "vitest";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
} from "node:zlib";
import {
  BROTLI_UPLOAD_QUALITY,
  isCompressibleTextArtifact,
  maybeCompressForUpload,
} from "../../../src/saas/compression.js";

// Highly compressible markdown (~7 KB) so the "shrinks" assertions have
// real headroom over brotli framing overhead.
const MARKDOWN = `# Design notes\n\n${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(120)}`;
const MARKDOWN_BYTES = Buffer.from(MARKDOWN, "utf8");

describe("isCompressibleTextArtifact", () => {
  it.each(["notes.md", "N.DOC.MD", "page.html", "page.htm", "data.txt", "rows.csv", "report.json", "doc.markdown"])(
    "treats %s as eligible",
    (name) => {
      expect(isCompressibleTextArtifact(name)).toBe(true);
    },
  );

  it.each(["photo.png", "photo.jpg", "anim.gif", "pic.webp", "shot.svg", "doc.pdf", "archive.zip", "noext", "baseline-x.json", "BASELINE-a.JSON", "dir/baseline-b.json"])(
    "treats %s as ineligible",
    (name) => {
      expect(isCompressibleTextArtifact(name)).toBe(false);
    },
  );

  it("excludes baseline-*.json even though plain .json is eligible", () => {
    expect(isCompressibleTextArtifact("report.json")).toBe(true);
    expect(isCompressibleTextArtifact("baseline-report.json")).toBe(false);
  });
});

describe("maybeCompressForUpload", () => {
  it("compresses eligible text with brotli q5 and round-trips", () => {
    const { bytes, contentEncoding } = maybeCompressForUpload(
      "notes.md",
      MARKDOWN_BYTES,
    );
    expect(contentEncoding).toBe("br");
    expect(bytes.length).toBeLessThan(MARKDOWN_BYTES.length);
    expect(brotliDecompressSync(bytes).equals(MARKDOWN_BYTES)).toBe(true);
  });

  it("uses quality 5 (matches the at-rest quality)", () => {
    expect(BROTLI_UPLOAD_QUALITY).toBe(5);
    const { bytes } = maybeCompressForUpload("notes.md", MARKDOWN_BYTES);
    const reference = brotliCompressSync(MARKDOWN_BYTES, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    });
    expect(bytes.equals(reference)).toBe(true);
  });

  it("leaves images byte-identical with no encoding", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { bytes, contentEncoding } = maybeCompressForUpload("photo.png", png);
    expect(contentEncoding).toBeNull();
    expect(bytes.equals(png)).toBe(true);
  });

  it("leaves baseline-*.json untouched", () => {
    const { bytes, contentEncoding } = maybeCompressForUpload(
      "baseline-abc.json",
      MARKDOWN_BYTES,
    );
    expect(contentEncoding).toBeNull();
    expect(bytes.equals(MARKDOWN_BYTES)).toBe(true);
  });

  it("leaves tiny text that does not shrink as plain", () => {
    const tiny = Buffer.from("hi", "utf8");
    const { bytes, contentEncoding } = maybeCompressForUpload("tiny.txt", tiny);
    expect(contentEncoding).toBeNull();
    expect(bytes.equals(tiny)).toBe(true);
  });

  it("leaves incompressible bytes as plain even for eligible names", () => {
    // Random-looking bytes: brotli cannot shrink them.
    const noise = Buffer.alloc(4096);
    let seed = 0x12345678;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[i] = (seed >>> 24) & 0xff;
    }
    const { bytes, contentEncoding } = maybeCompressForUpload("notes.md", noise);
    expect(contentEncoding).toBeNull();
    expect(bytes.equals(noise)).toBe(true);
  });
});
