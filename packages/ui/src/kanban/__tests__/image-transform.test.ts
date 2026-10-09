/**
 * Unit tests for the shared image-ingest matrix core
 * (packages/ui/src/kanban/imageTransform.ts).
 *
 * Pure decision/filename/byte logic only — no wasm, no DOM — so this suite
 * proves the policy branches identically for every runtime that imports them.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_INGEST_WIDTH,
  classifyImageUpload,
  decideImageTransform,
  withTrueExtension,
  buildPasteFilename,
  extensionForMime,
  stripJpegMetadata,
} from "../imageTransform";

describe("classifyImageUpload", () => {
  it("prefers MIME, falls back to filename extension", () => {
    expect(classifyImageUpload({ mimeType: "image/png" })).toBe("png");
    expect(classifyImageUpload({ mimeType: "image/jpeg" })).toBe("jpeg");
    expect(classifyImageUpload({ mimeType: "image/jpg" })).toBe("jpeg");
    expect(classifyImageUpload({ mimeType: "image/webp" })).toBe("webp");
    expect(classifyImageUpload({ mimeType: "image/gif" })).toBe("gif");
    expect(classifyImageUpload({ mimeType: "image/svg+xml" })).toBe("svg");
    expect(classifyImageUpload({ filename: "shot.PNG" })).toBe("png");
    expect(classifyImageUpload({ filename: "photo.jpeg" })).toBe("jpeg");
    expect(classifyImageUpload({ filename: "a.tiff" })).toBe("tiff");
    expect(classifyImageUpload({})).toBe("other");
    expect(classifyImageUpload({ mimeType: "text/csv" })).toBe("other");
  });
});

describe("decideImageTransform", () => {
  it("sends narrow PNG/BMP/TIFF to lossless WebP", () => {
    for (const kind of ["png", "bmp", "tiff"] as const) {
      const d = decideImageTransform({ kind, width: 800 });
      expect(d.branch).toBe("lossless-webp");
      expect(d.outExt).toBe("webp");
      expect(d.outMime).toBe("image/webp");
    }
  });

  it("keeps narrow JPEG as JPEG (never lossless WebP)", () => {
    const d = decideImageTransform({ kind: "jpeg", width: 1920 });
    expect(d.branch).toBe("keep-jpeg");
    expect(d.outExt).toBe("jpg");
  });

  it("resizes any kind wider than 1920 to width 1920 + WebP", () => {
    for (const kind of ["png", "jpeg", "webp", "bmp", "tiff"] as const) {
      const d = decideImageTransform({ kind, width: 1921 });
      expect(d.branch).toBe("resize-webp-q80");
      expect(d.targetWidth).toBe(MAX_INGEST_WIDTH);
      expect(d.outExt).toBe("webp");
    }
  });

  it("passes narrow WebP, GIF, SVG, and unknown kinds through", () => {
    expect(decideImageTransform({ kind: "webp", width: 800 }).branch).toBe(
      "passthrough",
    );
    for (const kind of ["gif", "svg", "other"] as const) {
      for (const width of [100, 1920, 4000]) {
        expect(decideImageTransform({ kind, width }).branch).toBe(
          "passthrough",
        );
      }
    }
  });

  it("NEVER takes JPEG through lossless WebP at any width", () => {
    for (const width of [1, 640, 1920, 1921, 3840, 8000]) {
      expect(decideImageTransform({ kind: "jpeg", width }).branch).not.toBe(
        "lossless-webp",
      );
    }
    for (const width of [1, 640, 1920]) {
      for (const kind of ["png", "bmp", "tiff"] as const) {
        expect(decideImageTransform({ kind, width }).branch).toBe(
          "lossless-webp",
        );
      }
    }
  });
});

describe("withTrueExtension / buildPasteFilename / extensionForMime", () => {
  it("rewrites to the true output extension", () => {
    expect(withTrueExtension("shot.png", "webp")).toBe("shot.webp");
    expect(withTrueExtension("photo.JPEG", "jpg")).toBe("photo.jpg");
    expect(withTrueExtension("noext", "webp")).toBe("noext.webp");
  });

  it("builds timestamped paste names with the given extension", () => {
    expect(
      buildPasteFilename(new Date("2026-10-07T12:34:56.789Z"), "webp"),
    ).toBe("paste-2026-10-07T12-34-56.webp");
    expect(buildPasteFilename(new Date("2026-10-07T12:34:56.000Z"), "png")).toBe(
      "paste-2026-10-07T12-34-56.png",
    );
  });

  it("maps MIME to matching extensions", () => {
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/svg+xml")).toBe("svg");
    expect(extensionForMime("text/csv")).toBe("bin");
    expect(extensionForMime("")).toBe("bin");
  });
});

describe("stripJpegMetadata", () => {
  // SOI, APP0(JFIF), APP1(Exif — dropped), COM (dropped), DQT, SOF0,
  // DHT, SOS(header len 8) + 4 scan bytes, EOI.
  const JPEG = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xe1, 0x00, 0x0c,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef,
    0xff, 0xfe, 0x00, 0x05, 0x41, 0x42, 0x43,
    0xff, 0xdb, 0x00, 0x04, 0x01, 0x02,
    0xff, 0xc0, 0x00, 0x04, 0x08, 0x00,
    0xff, 0xc4, 0x00, 0x04, 0x03, 0x04,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
    0x11, 0x22, 0x33, 0x44,
    0xff, 0xd9,
  ]);

  it("drops EXIF APP1 + COM and preserves everything else byte-identical", () => {
    const out = stripJpegMetadata(JPEG);
    // Kept: SOI + APP0(18) + DQT(6) + SOF0(6) + DHT(6) + SOS header+scan(12+4) + EOI(2).
    const expected = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x10,
      0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xdb, 0x00, 0x04, 0x01, 0x02,
      0xff, 0xc0, 0x00, 0x04, 0x08, 0x00,
      0xff, 0xc4, 0x00, 0x04, 0x03, 0x04,
      0xff, 0xda, 0x00, 0x08, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
      0x11, 0x22, 0x33, 0x44,
      0xff, 0xd9,
    ]);
    expect(out).toEqual(expected);
    expect(out.length).toBeLessThan(JPEG.length);
  });

  it("keeps non-Exif APP1 segments (e.g. XMP) while still dropping COM", () => {
    const xmp = JPEG.slice();
    // Rewrite the Exif header bytes to 'XMP\0' so the APP1 must survive.
    xmp[24] = 0x58; // 'X'
    xmp[25] = 0x4d; // 'M'
    xmp[26] = 0x50; // 'P'
    xmp[27] = 0x00;
    const out = stripJpegMetadata(xmp);
    // COM (FF FE 00 05 41 42 43) is gone; the XMP APP1 survives verbatim.
    expect(out.length).toBe(xmp.length - 7);
    expect(Array.from(out.slice(20, 34))).toEqual(Array.from(xmp.slice(20, 34)));
  });

  it("returns non-JPEG input unchanged", () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    expect(stripJpegMetadata(png)).toBe(png);
    expect(stripJpegMetadata(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });
});
