/**
 * Node acceptance tests for the shared image-ingest matrix — the SAME wasm
 * path browsers use (@jsquash/webp + @jsquash/resize, pure JS/wasm, no
 * native deps), loaded here from disk via `configureNodeImageCodecs`.
 *
 * Proves the ticket acceptance gates:
 *  1. PNG -> lossless WebP decodes PIXEL-EXACT (decoded-RGBA byte-compare).
 *  2. The >1920 path emits exactly width 1920 with SSIM >= .95 vs source.
 *  3. JPEG input NEVER takes the lossless-WebP branch.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { deflateSync } from "node:zlib";
import {
  configureNodeImageCodecs,
  transformImageBytes,
  decodePng,
} from "../../src/server/imageNodeCodecs.js";
import {
  decodeWebp,
  resizeRgbaToWidth,
  __resetImageCodecsForTests,
} from "@vibeflow-tools/ui/kanban/imageCodecs";
import { decideImageTransform } from "@vibeflow-tools/ui/kanban/imageTransform";

beforeAll(() => {
  __resetImageCodecsForTests();
  configureNodeImageCodecs();
});

// ── Fixture builders ─────────────────────────────────────────────────────────

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
  const crc = crc32(out.slice(4, 8 + data.length));
  view.setUint32(8 + data.length, crc);
  return out;
}

/** Minimal 8-bit RGBA PNG encoder (filter None) for fixtures. */
function encodePngRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(
      rgba.slice(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  }
  const idat = deflateSync(raw);
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Photographic-ish fixture: gradients + texture + hard edges (q80-friendly). */
function makePhotoRgba(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const checker = ((x >> 4) + (y >> 4)) & 1 ? 38 : 0;
      out[o] = (x * 255) / width + checker * 0.4;
      out[o + 1] =
        (y * 255) / height + 24 * Math.sin((x * y) / 997) + checker * 0.3;
      out[o + 2] =
        128 + 90 * Math.sin(x / 37) * Math.cos(y / 53) + checker * 0.5;
      out[o + 3] = 255;
    }
  }
  return out;
}

function toGray(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Float64Array {
  const g = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    g[i] =
      0.299 * (rgba[i * 4] as number) +
      0.587 * (rgba[i * 4 + 1] as number) +
      0.114 * (rgba[i * 4 + 2] as number);
  }
  return g;
}

/** Block SSIM (8x8, stride 8) averaged over the frame. */
function meanSsim(
  a: Uint8ClampedArray | Uint8Array,
  b: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): number {
  const ga = toGray(a, width, height);
  const gb = toGray(b, width, height);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let sum = 0;
  let n = 0;
  for (let by = 0; by + 8 <= height; by += 8) {
    for (let bx = 0; bx + 8 <= width; bx += 8) {
      let ma = 0;
      let mb = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          ma += ga[(by + y) * width + bx + x] as number;
          mb += gb[(by + y) * width + bx + x] as number;
        }
      }
      ma /= 64;
      mb /= 64;
      let sa = 0;
      let sb = 0;
      let sab = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const da = (ga[(by + y) * width + bx + x] as number) - ma;
          const db = (gb[(by + y) * width + bx + x] as number) - mb;
          sa += da * da;
          sb += db * db;
          sab += da * db;
        }
      }
      sa /= 63;
      sb /= 63;
      sab /= 63;
      sum +=
        ((2 * ma * mb + C1) * (2 * sab + C2)) /
        ((ma * ma + mb * mb + C1) * (sa + sb + C2));
      n++;
    }
  }
  return sum / n;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Node PNG decoder", () => {
  it("round-trips the fixture encoder byte-exact", () => {
    const rgba = makePhotoRgba(96, 64);
    const png = encodePngRgba(rgba, 96, 64);
    expect(png.slice(0, 8)).toEqual(
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const decoded = decodePng(png);
    expect(decoded.width).toBe(96);
    expect(decoded.height).toBe(64);
    expect(decoded.data).toEqual(rgba);
  });
});

describe("acceptance: PNG -> lossless WebP is pixel-exact", () => {
  it("decoded RGBA of the WebP equals the source RGBA byte-for-byte", async () => {
    const rgba = makePhotoRgba(96, 64);
    const png = encodePngRgba(rgba, 96, 64);
    const out = await transformImageBytes(png, {
      filename: "shot.png",
      mimeType: "image/png",
    });
    expect(out.branch).toBe("lossless-webp");
    expect(out.filename).toBe("shot.webp");
    expect(out.mime).toBe("image/webp");
    expect(out.width).toBe(96);
    // Lossless transcode must shrink photographic PNG input (policy 30-42%).
    expect(out.bytes.length).toBeLessThan(png.length);
    const decoded = await decodeWebp(out.bytes);
    expect(decoded.width).toBe(96);
    expect(decoded.height).toBe(64);
    expect(decoded.data).toEqual(rgba);
  }, 30000);
});

describe("acceptance: >1920 path emits width 1920 with SSIM >= .95", () => {
  it("resizes a 2048px PNG to 1920 q80 WebP", async () => {
    const src = makePhotoRgba(2048, 1152);
    const png = encodePngRgba(src, 2048, 1152);
    const out = await transformImageBytes(png, {
      filename: "wide.png",
      mimeType: "image/png",
    });
    expect(out.branch).toBe("resize-webp-q80");
    expect(out.width).toBe(1920);
    expect(out.filename).toBe("wide.webp");
    const decoded = await decodeWebp(out.bytes);
    expect(decoded.width).toBe(1920);
    expect(decoded.height).toBe(1080);
    // Reference: the same lanczos3 resize without the lossy encode.
    const reference = await resizeRgbaToWidth(
      { data: src, width: 2048, height: 1152 },
      1920,
    );
    const ssim = meanSsim(decoded.data, reference.data, 1920, 1080);
    expect(ssim).toBeGreaterThanOrEqual(0.95);
  }, 60000);
});

describe("acceptance: JPEG input NEVER takes the lossless branch", () => {
  it("decision sweep across widths", () => {
    for (const width of [1, 320, 1920, 1921, 3840, 8000]) {
      const branch = decideImageTransform({ kind: "jpeg", width }).branch;
      expect(branch).not.toBe("lossless-webp");
    }
  });

  it("narrow JPEG pipeline keeps JPEG bytes (+metadata strip, true ext)", async () => {
    const { default: jpegJs } = await import("jpeg-js");
    const src = makePhotoRgba(64, 48);
    const encoded = jpegJs.encode(
      { data: Buffer.from(src), width: 64, height: 48 },
      85,
    );
    // Splice an EXIF APP1 + COM after SOI so the strip has work to do.
    const exif = Uint8Array.from([
      0xff, 0xe1, 0x00, 0x0c, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xde, 0xad,
      0xbe, 0xef,
    ]);
    const com = Uint8Array.from([0xff, 0xfe, 0x00, 0x05, 0x41, 0x42, 0x43]);
    const withMeta = new Uint8Array(2 + exif.length + com.length + encoded.data.length - 2);
    withMeta.set(encoded.data.slice(0, 2), 0);
    withMeta.set(exif, 2);
    withMeta.set(com, 2 + exif.length);
    withMeta.set(encoded.data.slice(2), 2 + exif.length + com.length);

    const out = await transformImageBytes(withMeta, {
      filename: "photo.png", // wrong extension on purpose — true ext wins
      mimeType: "image/jpeg",
    });
    expect(out.branch).toBe("keep-jpeg");
    expect(out.filename).toBe("photo.jpg");
    expect(out.mime).toBe("image/jpeg");
    // Exactly the EXIF + COM bytes are gone; the image still decodes.
    expect(Array.from(out.bytes)).toEqual(Array.from(encoded.data));
    const re = await transformImageBytes(out.bytes, {
      filename: "photo.jpg",
      mimeType: "image/jpeg",
    });
    expect(re.bytes).toEqual(out.bytes); // idempotent — nothing left to strip
  }, 30000);

  it("wide JPEG pipeline resizes to WebP q80 (never lossless)", async () => {
    const { default: jpegJs } = await import("jpeg-js");
    const src = makePhotoRgba(2048, 1152);
    const encoded = jpegJs.encode(
      { data: Buffer.from(src), width: 2048, height: 1152 },
      85,
    );
    const out = await transformImageBytes(new Uint8Array(encoded.data), {
      filename: "wide.jpg",
      mimeType: "image/jpeg",
    });
    expect(out.branch).toBe("resize-webp-q80");
    expect(out.width).toBe(1920);
    expect(out.filename).toBe("wide.webp");
    const decoded = await decodeWebp(out.bytes);
    expect(decoded.width).toBe(1920);
  }, 60000);
});

describe("passthrough kinds stay byte-identical", () => {
  it("GIF/SVG/unknown are never touched", async () => {
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1]);
    const out = await transformImageBytes(gif, {
      filename: "anim.gif",
      mimeType: "image/gif",
    });
    expect(out.branch).toBe("passthrough");
    expect(out.bytes).toBe(gif);
    expect(out.filename).toBe("anim.gif");
  });
});
