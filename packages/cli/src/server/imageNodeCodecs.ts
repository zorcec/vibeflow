/**
 * Node-side wiring for the shared image-ingest matrix (CLI-side only).
 *
 * Pure JS + wasm: wasm bytes load from disk (bundled `dist/client/codecs`
 * in the published CLI, `node_modules/@jsquash` in source), compressed
 * inputs decode via dependency-free codecs — a minimal 8-bit PNG
 * decoder below and jpeg-js (BSD-3-Clause, pure JS) for JPEG. Browsers
 * decode via canvas instead; resize + WebP encode are the shared wasm
 * path (`@vibeflow-tools/ui/kanban/imageCodecs`) in both runtimes.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import {
  classifyImageUpload,
  transformRgbaUpload,
  type ImageTransformBranch,
} from "@vibeflow-tools/ui/kanban/imageTransform";
import {
  configureImageCodecs,
  type WasmAssetName,
  type WasmBytesLoader,
} from "@vibeflow-tools/ui/kanban";

export type { WasmAssetName } from "@vibeflow-tools/ui/kanban";

const WASM_ASSETS: WasmAssetName[] = [
  "webp_enc.wasm",
  "webp_dec.wasm",
  "squoosh_resize_bg.wasm",
];

function jsquashSubpath(name: WasmAssetName): string {
  return name === "squoosh_resize_bg.wasm"
    ? "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm"
    : name === "webp_dec.wasm"
      ? "@jsquash/webp/codec/dec/webp_dec.wasm"
      : "@jsquash/webp/codec/enc/webp_enc.wasm";
}

function findWasmAsset(name: WasmAssetName): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Published CLI: prebuild copies the binaries next to the bundles.
    join(here, "..", "client", "codecs", name),
    join(here, "..", "..", "client", "codecs", name),
    // Flat dist/ bundle layout (dist/index.js entry, chunks beside it).
    join(here, "client", "codecs", name),
    // Source checkout after a build (tests, dev server).
    join(here, "..", "..", "dist", "client", "codecs", name),
    // Source checkout without a build: the workspace @jsquash install
    // (ui owns the dependency).
    join(here, "..", "..", "..", "ui", "node_modules", jsquashSubpath(name)),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`image codec wasm not found: ${name}`);
}

/** Configure the shared codecs from disk (idempotent per process). */
export function configureNodeImageCodecs(): void {
  const loadWasmBytes: WasmBytesLoader = async (name) =>
    new Uint8Array(readFileSync(findWasmAsset(name)));
  configureImageCodecs({ loadWasmBytes });
}

export function wasmAssetNames(): WasmAssetName[] {
  return [...WASM_ASSETS];
}

/** Absolute disk path of a wasm asset (server route + prebuild copy). */
export function wasmAssetPath(name: WasmAssetName): string {
  return findWasmAsset(name);
}

// ── Minimal 8-bit PNG decoder (RFC 2083: None/Sub/Up/Average/Paeth) ──────────

export interface DecodedRgba {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode 8-bit non-interlaced PNG (color types 0/2/6) to RGBA. */
export function decodePng(png: Uint8Array): DecodedRgba {
  const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (png[i] !== PNG_MAGIC[i]) throw new Error("not a PNG");
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: number[] = [];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (pos + 8 <= png.length) {
    const len = view.getUint32(pos);
    const type =
      String.fromCharCode(png[pos + 4] as number) +
      String.fromCharCode(png[pos + 5] as number) +
      String.fromCharCode(png[pos + 6] as number) +
      String.fromCharCode(png[pos + 7] as number);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > png.length) throw new Error("truncated PNG");
    if (type === "IHDR") {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = png[dataStart + 8] as number;
      colorType = png[dataStart + 9] as number;
      const interlace = png[dataStart + 12] as number;
      if (bitDepth !== 8 || interlace !== 0) {
        throw new Error(`unsupported PNG (depth ${bitDepth}, interlace ${interlace})`);
      }
      if (colorType !== 0 && colorType !== 2 && colorType !== 6) {
        throw new Error(`unsupported PNG color type ${colorType}`);
      }
    } else if (type === "IDAT") {
      for (let i = dataStart; i < dataEnd; i++) idat.push(png[i] as number);
    } else if (type === "IEND") {
      break;
    }
    pos = dataEnd + 4;
  }
  if (width === 0 || height === 0) throw new Error("missing IHDR");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(Uint8Array.from(idat));
  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++] as number;
    for (let x = 0; x < width; x++) {
      let r: number; let g: number; let b: number; let a = 255;
      const get = (xx: number, c: number): number => {
        if (xx < 0) return 0;
        return out[(y * width + xx) * 4 + c] as number;
      };
      const up = (c: number): number =>
        y === 0 ? 0 : (out[((y - 1) * width + x) * 4 + c] as number);
      const upLeft = (c: number): number =>
        x === 0 || y === 0 ? 0 : (out[((y - 1) * width + x - 1) * 4 + c] as number);
      const recon = (f: number, left: number, upv: number, upL: number): number => {
        if (f === 0) return raw[p++] as number;
        if (f === 1) return ((raw[p++] as number) + left) & 0xff;
        if (f === 2) return ((raw[p++] as number) + upv) & 0xff;
        if (f === 3) return ((raw[p++] as number) + ((left + upv) >> 1)) & 0xff;
        return ((raw[p++] as number) + paethPredictor(left, upv, upL)) & 0xff;
      };
      if (channels === 1) {
        const v = recon(filter, get(x - 1, 0), up(0), upLeft(0));
        r = g = b = v;
      } else {
        r = recon(filter, get(x - 1, 0), up(0), upLeft(0));
        g = recon(filter, get(x - 1, 1), up(1), upLeft(1));
        b = recon(filter, get(x - 1, 2), up(2), upLeft(2));
        if (channels === 4) a = recon(filter, get(x - 1, 3), up(3), upLeft(3));
      }
      void stride;
      const o = (y * width + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return { data: out, width, height };
}

/** Decode JPEG bytes to RGBA via jpeg-js (pure JS, no native deps). */
export async function decodeJpeg(jpeg: Uint8Array): Promise<DecodedRgba> {
  const mod = await import("jpeg-js");
  // SAFETY: jpeg-js has no usable ESM types here; its documented API is
  // decode(buffer, opts) -> {data: Buffer(RGBA), width, height}.
  const jpegJs = (mod as unknown as { default?: unknown }).default ??
    (mod as unknown as object);
  const decode = (jpegJs as {
    decode: (
      buf: Uint8Array,
      opts?: { maxMemoryUsageInMB?: number },
    ) => { data: Uint8Array; width: number; height: number };
  }).decode;
  const out = decode(jpeg, { maxMemoryUsageInMB: 512 });
  return {
    data: new Uint8ClampedArray(out.data.buffer, out.data.byteOffset, out.data.byteLength),
    width: out.width,
    height: out.height,
  };
}

export interface NodeTransformResult {
  bytes: Uint8Array;
  filename: string;
  mime: string;
  branch: ImageTransformBranch;
  width: number;
  height: number;
}

/**
 * Run the full matrix on compressed image bytes in Node (tests + local
 * CLI flows). GIF/SVG/unknown pass through untouched; WebP<=1920 passes
 * through; everything else goes through the shared wasm pipeline.
 */
export async function transformImageBytes(
  input: Uint8Array,
  opts: { filename: string; mimeType?: string },
): Promise<NodeTransformResult> {
  configureNodeImageCodecs();
  const kind = classifyImageUpload({
    mimeType: opts.mimeType,
    filename: opts.filename,
  });
  if (kind === "gif" || kind === "svg" || kind === "other") {
    return {
      bytes: input,
      filename: opts.filename,
      mime: opts.mimeType ?? "application/octet-stream",
      branch: "passthrough",
      width: 0,
      height: 0,
    };
  }
  let rgba: DecodedRgba;
  if (kind === "jpeg") {
    rgba = await decodeJpeg(input);
  } else if (kind === "webp") {
    const { decodeWebp } = await import("@vibeflow-tools/ui/kanban");
    rgba = await decodeWebp(input);
  } else {
    rgba = decodePng(input);
  }
  const out = await transformRgbaUpload({
    rgba,
    kind,
    originalBytes: input,
    originalName: opts.filename,
    originalMime: opts.mimeType ?? "",
  });
  return { ...out, height: Math.max(1, Math.round((rgba.height * out.width) / Math.max(1, rgba.width))) };
}
