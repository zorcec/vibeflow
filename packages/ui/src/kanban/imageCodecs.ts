/**
 * Shared wasm codec layer for the image-ingest matrix — ONE implementation
 * for the browser bundles and the CLI Node server (pure JS + wasm only;
 * no native dependencies).
 *
 * Codecs (lazy, never in the eager evaluation path):
 * - WebP encode/decode: @jsquash/webp (Apache-2.0 wrapper, libwebp codec
 *   under its BSD-style terms) — Emscripten glue is bundled, the .wasm
 *   binaries (~453KB total) load on first transform only.
 * - Resize (lanczos3): @jsquash/resize (Apache-2.0) via its wasm-bindgen
 *   `squoosh_resize` core directly — bypasses the package index so the
 *   hqx/magic-kernel glue and the `ImageData` global never enter the graph.
 *
 * Wasm bytes are runtime-supplied (see `configureImageCodecs`): browsers
 * fetch them from the CLI server's codec route, Node reads them from disk.
 * Only the non-SIMD encoder build is used — one binary everywhere, no
 * feature-detect fork between glue and bytes.
 */

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** The three wasm binaries the pipeline needs (original upstream names). */
export type WasmAssetName =
  | "webp_enc.wasm"
  | "webp_dec.wasm"
  | "squoosh_resize_bg.wasm";

export type WasmBytesLoader = (name: WasmAssetName) => Promise<Uint8Array>;

let wasmBytesLoader: WasmBytesLoader | null = null;

/**
 * Provide the wasm bytes for this runtime. Browser entries pass a
 * same-origin (kanban) or server-absolute (overlay) fetch; Node passes an
 * fs read. Until configured, any codec use throws — callers treat that as
 * "keep the raw bytes" so uploads never fail or drop.
 */
export function configureImageCodecs(opts: {
  loadWasmBytes: WasmBytesLoader;
}): void {
  wasmBytesLoader = opts.loadWasmBytes;
}

/** Browser convenience: fetch the binaries from a base URL (no listing). */
export function configureWasmBaseUrl(baseUrl: string): void {
  const base = baseUrl.replace(/\/+$/, "");
  configureImageCodecs({
    loadWasmBytes: async (name) => {
      const res = await fetch(`${base}/${name}`);
      if (!res.ok) throw new Error(`codec fetch failed: ${name}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  });
}

async function loadWasmModule(name: WasmAssetName): Promise<WebAssembly.Module> {
  if (!wasmBytesLoader) throw new Error("image codecs not configured");
  const bytes = await wasmBytesLoader(name);
  // Copy into a fresh ArrayBuffer-backed view: loader buffers may ride on
  // SharedArrayBuffer-backed memory, which WebAssembly.compile rejects.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return WebAssembly.compile(owned);
}

// ── WebP encoder ─────────────────────────────────────────────────────────────

interface WebPEncodeModule {
  encode(
    data: Uint8Array | Uint8ClampedArray | ArrayBuffer,
    width: number,
    height: number,
    options: Record<string, number>,
  ): Uint8Array | null;
}

let encoderPromise: Promise<WebPEncodeModule> | null = null;

function getWebpEncoder(): Promise<WebPEncodeModule> {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      const [{ default: factory }, { initEmscriptenModule }, wasmModule] =
        await Promise.all([
          import("@jsquash/webp/codec/enc/webp_enc.js"),
          import("@jsquash/webp/utils.js"),
          loadWasmModule("webp_enc.wasm"),
        ]);
      // SAFETY: the Emscripten factory + our compiled Encoder module produce
      // the documented WebPModule shape (encode(data, w, h, opts)); the local
      // WebPEncodeModule interface mirrors exactly the methods we call.
      const module = (await initEmscriptenModule(
        factory as never,
        wasmModule,
      )) as unknown as WebPEncodeModule;
      return module;
    })();
    // A failed init must not poison later attempts (e.g. transient fetch).
    void encoderPromise.catch(() => {
      encoderPromise = null;
    });
  }
  return encoderPromise;
}

const WEBP_BASE_OPTIONS = {
  quality: 75,
  target_size: 0,
  target_PSNR: 0,
  method: 4,
  sns_strength: 50,
  filter_strength: 60,
  filter_sharpness: 0,
  filter_type: 1,
  partitions: 0,
  segments: 4,
  pass: 1,
  show_compressed: 0,
  preprocessing: 0,
  autofilter: 0,
  partition_limit: 0,
  alpha_compression: 1,
  alpha_filtering: 1,
  alpha_quality: 100,
  lossless: 0,
  exact: 0,
  image_hint: 0,
  emulate_jpeg_size: 0,
  thread_level: 0,
  low_memory: 0,
  near_lossless: 100,
  use_delta_palette: 0,
  use_sharp_yuv: 0,
};

/** Lossless WebP (policy PNG path): cwebp `-q 100 -lossless 1 -m 6`. */
export async function encodeLosslessWebp(image: RgbaImage): Promise<Uint8Array> {
  const encoder = await getWebpEncoder();
  const out = encoder.encode(image.data, image.width, image.height, {
    ...WEBP_BASE_OPTIONS,
    quality: 100,
    lossless: 1,
    method: 6,
  });
  if (!out) throw new Error("lossless webp encode failed");
  return new Uint8Array(out);
}

/** Lossy WebP q80 (policy >1920 path). */
export async function encodeLossyWebp(
  image: RgbaImage,
  quality = 80,
): Promise<Uint8Array> {
  const encoder = await getWebpEncoder();
  const out = encoder.encode(image.data, image.width, image.height, {
    ...WEBP_BASE_OPTIONS,
    quality,
    method: 4,
  });
  if (!out) throw new Error("lossy webp encode failed");
  return new Uint8Array(out);
}

// ── WebP decoder (Node/tests; browsers decode via canvas) ────────────────────

interface WebPDecodeModule {
  decode(data: Uint8Array | ArrayBuffer): {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  } | null;
}

let decoderPromise: Promise<WebPDecodeModule> | null = null;

function getWebpDecoder(): Promise<WebPDecodeModule> {
  if (!decoderPromise) {
    decoderPromise = (async () => {
      const [{ default: factory }, { initEmscriptenModule }, wasmModule] =
        await Promise.all([
          import("@jsquash/webp/codec/dec/webp_dec.js"),
          import("@jsquash/webp/utils.js"),
          loadWasmModule("webp_dec.wasm"),
        ]);
      // SAFETY: same Emscripten invariant as the encoder — factory plus our
      // compiled Decoder module yields decode(buffer); the local interface
      // mirrors exactly the method we call.
      const module = (await initEmscriptenModule(
        factory as never,
        wasmModule,
      )) as unknown as WebPDecodeModule;
      return module;
    })();
    void decoderPromise.catch(() => {
      decoderPromise = null;
    });
  }
  return decoderPromise;
}

/** Decode WebP bytes to RGBA (pixel-exact for lossless sources). */
export async function decodeWebp(bytes: Uint8Array): Promise<RgbaImage> {
  const decoder = await getWebpDecoder();
  const out = decoder.decode(bytes);
  if (!out) throw new Error("webp decode failed");
  return {
    data: new Uint8ClampedArray(out.data),
    width: out.width,
    height: out.height,
  };
}

// ── Resize (lanczos3, shared by every runtime) ───────────────────────────────

interface ResizeBinding {
  (bytes: Uint8Array, w: number, h: number): void;
}

let resizerPromise: Promise<{
  run: (
    input: Uint8Array,
    inW: number,
    inH: number,
    outW: number,
    outH: number,
  ) => Uint8ClampedArray;
}> | null = null;

function getResizer(): Promise<{
  run: (
    input: Uint8Array,
    inW: number,
    inH: number,
    outW: number,
    outH: number,
  ) => Uint8ClampedArray;
}> {
  if (!resizerPromise) {
    resizerPromise = (async () => {
      const [binding, wasmModule] = await Promise.all([
        import("@jsquash/resize/lib/resize/pkg/squoosh_resize.js"),
        loadWasmModule("squoosh_resize_bg.wasm"),
      ]);
      // SAFETY: wasm-bindgen init accepts InitInput, which explicitly
      // includes WebAssembly.Module — the narrow local type just names the
      // single shape we pass.
      const initWasm = binding.default as unknown as (
        m: WebAssembly.Module,
      ) => Promise<unknown>;
      await initWasm(wasmModule);
      // SAFETY: squoosh_resize's documented export is resize(u8,w,h,ow,oh,
      // typIdx,premultiply,linearRGB) -> Uint8ClampedArray (see its .d.ts);
      // the signature below copies that contract verbatim.
      const resize = binding.resize as unknown as (
        input: Uint8Array,
        inW: number,
        inH: number,
        outW: number,
        outH: number,
        // typ_idx 3 = lanczos3; premultiply + linearRGB match jsquash defaults.
        typIdx: number,
        premultiply: boolean,
        linearRGB: boolean,
      ) => Uint8ClampedArray;
      const run: (
        input: Uint8Array,
        inW: number,
        inH: number,
        outW: number,
        outH: number,
      ) => Uint8ClampedArray = (input, inW, inH, outW, outH) =>
        resize(
          input instanceof Uint8Array ? input : new Uint8Array(input),
          inW,
          inH,
          outW,
          outH,
          3,
          true,
          true,
        );
      return { run };
    })();
    void resizerPromise.catch(() => {
      resizerPromise = null;
    });
  }
  return resizerPromise;
}

/** Width-proportional lanczos3 downscale (aspect preserved). */
export async function resizeRgbaToWidth(
  image: RgbaImage,
  targetWidth: number,
): Promise<RgbaImage> {
  const { run } = await getResizer();
  const scale = targetWidth / image.width;
  const outH = Math.max(1, Math.round(image.height * scale));
  const input =
    image.data instanceof Uint8Array
      ? image.data
      : new Uint8Array(image.data);
  const data = run(input, image.width, image.height, targetWidth, outH);
  return { data, width: targetWidth, height: outH };
}

/** Reset cached codec state (tests only — isolates wasm-load scenarios). */
export function __resetImageCodecsForTests(): void {
  encoderPromise = null;
  decoderPromise = null;
  resizerPromise = null;
  wasmBytesLoader = null;
}

export type { ResizeBinding };
