/**
 * Capture-time image matrix for verify screenshots (T2): the raw PNG from
 * `page.screenshot()` runs through T1's Node pipeline (`transformImageBytes`)
 * before `saveFile`, and the emitted `verify-screenshot.webp` keeps its
 * system flag via `SYSTEM_FILE_NAMES`.
 *
 * Proves the capture contract (same wasm path browsers use, no sharp):
 *  1. Narrow PNG -> lossless WebP, TRUE `.webp` name, pixel-exact decode.
 *  2. Wide (>1920) PNG -> width exactly 1920, lossy WebP branch.
 *  3. `verify-screenshot.webp` backfills `system: true` (legacy `.png`
 *     name still recognized — flag semantics unchanged).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { deflateSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configureNodeImageCodecs,
  transformImageBytes,
} from "../../src/server/imageNodeCodecs.js";
import {
  decodeWebp,
  __resetImageCodecsForTests,
} from "@vibeflow-tools/ui/kanban/imageCodecs";
import {
  ensureFilesDir,
  getFilesDir,
  listFiles,
  saveFile,
} from "../../src/core/files.js";
import { createTask } from "../../src/core/tasks.js";

beforeAll(() => {
  __resetImageCodecsForTests();
  configureNodeImageCodecs();
});

// ── Minimal PNG fixture builder (8-bit RGBA, filter None) ───────────────────

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

/** Small photographic-ish gradient so the lossy path has real work to do. */
function makeShotRgba(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = (x * 255) / width;
      out[o + 1] = (y * 255) / height + 20 * Math.sin(x / 13);
      out[o + 2] = 128 + 80 * Math.sin(x / 29) * Math.cos(y / 41);
      out[o + 3] = 255;
    }
  }
  return out;
}

describe("verify capture transform", () => {
  it("narrow PNG screenshot -> lossless WebP with true .webp name", async () => {
    const rgba = makeShotRgba(96, 64);
    const png = encodePngRgba(rgba, 96, 64);
    const out = await transformImageBytes(png, {
      filename: "verify-screenshot.png",
      mimeType: "image/png",
    });
    expect(out.branch).toBe("lossless-webp");
    expect(out.filename).toBe("verify-screenshot.webp");
    expect(out.mime).toBe("image/webp");
    expect(out.width).toBe(96);
    const decoded = await decodeWebp(out.bytes);
    expect(decoded.width).toBe(96);
    expect(decoded.height).toBe(64);
    expect(decoded.data).toEqual(rgba);
  }, 30000);

  it("wide PNG screenshot -> width 1920 lossy WebP", async () => {
    const src = makeShotRgba(2048, 64);
    const png = encodePngRgba(src, 2048, 64);
    const out = await transformImageBytes(png, {
      filename: "verify-screenshot.png",
      mimeType: "image/png",
    });
    expect(out.branch).toBe("resize-webp-q80");
    expect(out.width).toBe(1920);
    expect(out.filename).toBe("verify-screenshot.webp");
    const decoded = await decodeWebp(out.bytes);
    expect(decoded.width).toBe(1920);
  }, 60000);
});

describe("verify screenshot system flag", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "verify-shot-flag-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("backfill flags verify-screenshot.webp (and keeps legacy .png)", () => {
    const task = createTask(tempDir, {
      title: "Flag test",
      description: "",
      status: "todo",
      selector: "/",
    });
    // Ref-less on-disk evidence, as a real capture leaves it.
    ensureFilesDir(tempDir, task.id);
    writeFileSync(
      join(getFilesDir(tempDir, task.id), "verify-screenshot.webp"),
      Buffer.from("webp-bytes"),
    );
    writeFileSync(
      join(getFilesDir(tempDir, task.id), "verify-screenshot.png"),
      Buffer.from("legacy-png"),
    );
    // Any later write triggers the lazy backfill over the on-disk files.
    saveFile(tempDir, task.id, "verify-after.json", Buffer.from("{}"));

    const files = listFiles(tempDir, task.id);
    expect(
      files.find((f) => f.name === "verify-screenshot.webp")?.system,
    ).toBe(true);
    expect(
      files.find((f) => f.name === "verify-screenshot.png")?.system,
    ).toBe(true);
  });
});
