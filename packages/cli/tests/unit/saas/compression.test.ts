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
import {
  BROTLI_ENCODING,
  BROTLI_QUALITY,
  isCompressibleTextArtifact as sharedEligible,
} from "@vibeflow-tools/shared";

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

  it.each(["photo.png", "photo.jpg", "anim.gif", "pic.webp", "shot.svg", "doc.pdf", "archive.zip", "noext"])(
    "treats %s as ineligible",
    (name) => {
      expect(isCompressibleTextArtifact(name)).toBe(false);
    },
  );

  it.each(["baseline-x.json", "BASELINE-a.JSON", "dir/baseline-b.json"])(
    "treats %s as eligible (baselines compress like any json)",
    (name) => {
      expect(isCompressibleTextArtifact(name)).toBe(true);
    },
  );

  it("includes baseline-*.json exactly like plain .json (server parity, ticket 7a2df818)", () => {
    expect(isCompressibleTextArtifact("report.json")).toBe(true);
    expect(isCompressibleTextArtifact("baseline-report.json")).toBe(true);
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
    expect(BROTLI_UPLOAD_QUALITY).toBe(BROTLI_QUALITY);
    expect(BROTLI_UPLOAD_QUALITY).toBe(5);
    const { bytes } = maybeCompressForUpload("notes.md", MARKDOWN_BYTES);
    const reference = brotliCompressSync(MARKDOWN_BYTES, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    });
    expect(bytes.equals(reference)).toBe(true);
  });

  it("tracks the shared source of truth (no drift between CLI and server rules)", () => {
    // The wrapper must not grow its own eligibility: every sample agrees
    // with @vibeflow-tools/shared, including baselines (server rule).
    const names = [
      "notes.md",
      "N.DOC.MD",
      "page.html",
      "page.htm",
      "data.txt",
      "rows.csv",
      "report.json",
      "doc.markdown",
      "baseline-x.json",
      "BASELINE-a.JSON",
      "dir/baseline-b.json",
      "photo.png",
      "archive.zip",
      "noext",
    ];
    for (const name of names) {
      expect(isCompressibleTextArtifact(name)).toBe(sharedEligible(name));
    }
    expect(BROTLI_ENCODING).toBe("br");
  });

  it("leaves images byte-identical with no encoding", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { bytes, contentEncoding } = maybeCompressForUpload("photo.png", png);
    expect(contentEncoding).toBeNull();
    expect(bytes.equals(png)).toBe(true);
  });

  it("compresses baseline-*.json like any other eligible json", () => {
    const { bytes, contentEncoding } = maybeCompressForUpload(
      "baseline-abc.json",
      MARKDOWN_BYTES,
    );
    expect(contentEncoding).toBe("br");
    expect(bytes.length).toBeLessThan(MARKDOWN_BYTES.length);
    expect(brotliDecompressSync(bytes).equals(MARKDOWN_BYTES)).toBe(true);
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
