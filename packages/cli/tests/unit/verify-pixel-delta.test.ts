/**
 * Pixel-diff math for `verify --pixels` (ticket 080966d13869639d).
 *
 * `computePixelDelta` compares two decoded RGBA images of the task selector
 * region: `max` is the largest per-channel absolute delta (0-255), `pct` the
 * share of pixels with ANY channel different (1-decimal), `sameSize` false
 * when the two captures are not comparable at all (reported, never diffed).
 *
 * These tests bite: they run the REAL repo PNG decoder (`decodePng` from
 * `src/server/imageNodeCodecs.ts` — the dependency-free codec the evidence
 * pipeline reuses) over locally-encoded PNGs, so a decoder that cannot read
 * what `element.screenshot()` writes fails here, not in production.
 */
import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import {
  computePixelDelta,
  formatPixelDelta,
  pixelDemandMet,
  type RgbaImage,
} from "../../src/core/pixel-diff.js";
import { decodePng } from "../../src/server/imageNodeCodecs.js";

// ── Minimal PNG encoder (8-bit RGBA, filter None) ───────────────────────────
// Mirrors tests/unit/verify-screenshot-capture.test.ts. Playwright's
// element.screenshot() writes exactly this shape, so the round-trip below
// proves decodePng reads the real capture bytes.

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)));
  return out;
}

function encodePngRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(
      rgba.slice(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  }
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function solid(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

function img(data: Uint8ClampedArray, width: number, height: number): RgbaImage {
  return { data, width, height };
}

describe("computePixelDelta", () => {
  it("identical images diff to zero with sameSize true", () => {
    const a = img(solid(8, 8, 200, 210, 220), 8, 8);
    const b = img(solid(8, 8, 200, 210, 220), 8, 8);
    expect(computePixelDelta(a, b)).toEqual({ max: 0, pct: 0, sameSize: true });
    expect(formatPixelDelta(computePixelDelta(a, b))).toBe(
      "PIXEL_DELTA=0/255 (0% of pixels changed)",
    );
  });

  it("a 15/255 change on a small region reports max 15 and the exact share", () => {
    // 10x10 card, 5 pixels glow-shifted by 15 on one channel (the bell case).
    const before = solid(10, 10, 240, 240, 240);
    const after = solid(10, 10, 240, 240, 240);
    for (let i = 0; i < 5; i++) {
      after[i * 4] = 255; // 240 -> 255: a 15/255 red-channel delta
    }
    const delta = computePixelDelta(img(before, 10, 10), img(after, 10, 10));
    expect(delta.max).toBe(15);
    expect(delta.pct).toBe(5);
    expect(delta.sameSize).toBe(true);
    expect(formatPixelDelta(delta)).toBe("PIXEL_DELTA=15/255 (5% of pixels changed)");
  });

  it("a repaint reports the largest channel delta, not the average", () => {
    const before = solid(4, 4, 240, 240, 240);
    const after = solid(4, 4, 240, 240, 240);
    after[0] = 255; // +15 on one pixel's red channel
    after[4] = 40; // -200 on another pixel's red channel
    const delta = computePixelDelta(img(before, 4, 4), img(after, 4, 4));
    expect(delta.max).toBe(200);
    expect(delta.pct).toBe(12.5); // 2 of 16 pixels
    expect(formatPixelDelta(delta)).toBe(
      "PIXEL_DELTA=200/255 (12.5% of pixels changed)",
    );
  });

  it("size mismatch is reported, never diffed", () => {
    const a = img(solid(10, 10, 1, 2, 3), 10, 10);
    const b = img(solid(12, 10, 250, 250, 250), 12, 10);
    const delta = computePixelDelta(a, b);
    expect(delta).toEqual({ max: 0, pct: 0, sameSize: false });
    expect(
      formatPixelDelta(delta, {
        baseline: { width: 10, height: 10 },
        after: { width: 12, height: 10 },
      }),
    ).toBe("PIXEL_DELTA=unknown/255 (size mismatch 10x10 vs 12x10 — not diffed)");
  });

  it("decodes real PNG bytes through the repo decoder before diffing", () => {
    const before = solid(6, 6, 240, 240, 240);
    const after = solid(6, 6, 240, 240, 240);
    for (let i = 0; i < 3; i++) after[i * 4 + 1] = 255; // +15 green
    const a = decodePng(encodePngRgba(before, 6, 6));
    const b = decodePng(encodePngRgba(after, 6, 6));
    expect(a.width).toBe(6);
    expect(b.height).toBe(6);
    const delta = computePixelDelta(a, b);
    expect(delta.max).toBe(15);
    // 3 of 36 pixels: 8.333...% rounds to 1 decimal.
    expect(delta.pct).toBe(8.3);
    expect(delta.sameSize).toBe(true);
  });
});

describe("pixelDemandMet", () => {
  it("default threshold 0 never fails on its own", () => {
    expect(pixelDemandMet(undefined, 0)).toBe(true);
    expect(pixelDemandMet({ max: 0, pct: 0, sameSize: true }, 0)).toBe(true);
  });

  it("a demanded visible change fails when the delta is too small", () => {
    expect(pixelDemandMet({ max: 15, pct: 5, sameSize: true }, 40)).toBe(false);
    expect(pixelDemandMet({ max: 200, pct: 50, sameSize: true }, 40)).toBe(true);
  });

  it("a size mismatch never satisfies a demand", () => {
    expect(pixelDemandMet({ max: 0, pct: 0, sameSize: false }, 40)).toBe(false);
    expect(pixelDemandMet({ max: 0, pct: 0, sameSize: false }, 0)).toBe(true);
  });
});
