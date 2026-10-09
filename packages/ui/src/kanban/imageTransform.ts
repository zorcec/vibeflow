/**
 * Shared image-ingest transform: the measured image matrix, dependency-free.
 *
 * Browser-safe by construction (no Node imports, no native deps) so BOTH the
 * browser client bundles (kanban DetailPanel, overlay paste path) and the CLI
 * Node server (via `@vibeflow-tools/ui/kanban/imageTransform`) can import it.
 * Encode/resize run on ONE wasm implementation (`./imageCodecs`, pure JS +
 * @jsquash wasm, lazily loaded) in every runtime — there is no per-runtime
 * codec fork to drift.
 *
 * Policy (measured, owner-approved):
 * - PNG (any dims): lossless WebP transcode (~30-42% of bytes, SSIM 1.0).
 * - >1920px wide: lanczos3 resize to width 1920 + WebP q80 (~17-27%,
 *   SSIM .955-.989).
 * - JPEG <=1920: keep JPEG, strip metadata only (byte-level APP/COM drop,
 *   no re-encode).
 * - JPEG >1920: resize to 1920 + q80 (WebP here, for one true extension).
 * - NEVER lossless-WebP from JPEG input (measured 358% size blowup).
 * - Stored/uploaded files always carry their TRUE extension (.webp/.jpg).
 *
 * GIF/SVG always pass through untouched (re-encoding would destroy
 * animation/vectors; drawing SVG to canvas would also taint it).

/** Max ingested image width in px — wider sources are resized down to this. */
export const MAX_INGEST_WIDTH = 1920;

/** Quality for the lossy WebP resize path (canvas + sharp agree on it). */
export const LOSSY_WEBP_QUALITY = 0.8;

/** Raster/animation/vector kinds the matrix distinguishes. */
export type ImageKind =
  | "png"
  | "jpeg"
  | "webp"
  | "gif"
  | "bmp"
  | "tiff"
  | "svg"
  | "other";

/** Transform branches — identical in every runtime (one wasm path). */
export type ImageTransformBranch =
  | "lossless-webp"
  | "resize-webp-q80"
  | "keep-jpeg"
  | "passthrough";

export interface ImageTransformDecision {
  branch: ImageTransformBranch;
  /** Output MIME the stored file must be served/typed as. */
  outMime: string;
  /** TRUE output extension (no leading dot). */
  outExt: string;
  /** Resize target width; present only on the resize branch. */
  targetWidth?: number;
}

/** Classify an upload by MIME first, filename extension as fallback. */
export function classifyImageUpload(input: {
  mimeType?: string;
  filename?: string;
}): ImageKind {
  const mime = (input.mimeType ?? "").toLowerCase();
  const mimeMap: Record<string, ImageKind> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/x-ms-bmp": "bmp",
    "image/tiff": "tiff",
    "image/svg+xml": "svg",
  };
  if (mimeMap[mime]) return mimeMap[mime];
  const ext = (input.filename ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const extMap: Record<string, ImageKind> = {
    png: "png",
    jpg: "jpeg",
    jpeg: "jpeg",
    webp: "webp",
    gif: "gif",
    bmp: "bmp",
    tif: "tiff",
    tiff: "tiff",
    svg: "svg",
  };
  if (ext && extMap[ext]) return extMap[ext];
  return "other";
}

/** The matrix — same branches in every runtime (one shared wasm path). */
export function decideImageTransform(input: {
  kind: ImageKind;
  width: number;
}): ImageTransformDecision {
  const { kind, width } = input;
  const wide = width > MAX_INGEST_WIDTH;

  // Animation and vectors are never touched in any runtime.
  if (kind === "gif" || kind === "svg" || kind === "other") {
    return { branch: "passthrough", outMime: "", outExt: "" };
  }

  if (wide) {
    // One uniform wide path: resize to 1920 + lossy WebP q80. JPEG is
    // allowed JPEG-or-WebP here; WebP keeps a single true extension.
    return {
      branch: "resize-webp-q80",
      outMime: "image/webp",
      outExt: "webp",
      targetWidth: MAX_INGEST_WIDTH,
    };
  }

  // Narrow path: never resize, never take JPEG through lossless WebP.
  if (kind === "jpeg") {
    return { branch: "keep-jpeg", outMime: "image/jpeg", outExt: "jpg" };
  }
  if (kind === "webp") {
    return { branch: "passthrough", outMime: "image/webp", outExt: "webp" };
  }
  // png, bmp, tiff: lossless WebP everywhere (wasm encoder, all runtimes).
  return {
    branch: "lossless-webp",
    outMime: "image/webp",
    outExt: "webp",
  };
}

/** Rewrite a filename to the TRUE output extension (no lying extensions). */
export function withTrueExtension(filename: string, outExt: string): string {
  const base = filename.replace(/\.[a-z0-9]+$/i, "");
  return `${base}.${outExt}`;
}

/** `paste-2026-10-07T12-34-56.<ext>` — timestamp shape shared by all clients. */
export function buildPasteFilename(
  now: Date = new Date(),
  ext = "webp",
): string {
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `paste-${ts}.${ext}`;
}

/** Extension matching raw bytes when no transform ran (never throws). */
export function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  const sub = /^image\/([a-z0-9]+)/i.exec(mimeType)?.[1]?.toLowerCase();
  if (!sub) return "bin";
  if (sub === "jpeg") return "jpg";
  if (sub === "svg+xml") return "svg";
  return sub;
}

// ── Byte-level JPEG metadata strip (plain JS, every runtime) ────────────────

/**
 * Drop EXIF (APP1) and COM segments from JPEG bytes without re-encoding —
 * the policy's "strip EXIF/COM only" for the keep-jpeg branch. Every other
 * segment (JFIF APP0, Adobe APP14, ICC APP2, quant/scan tables, image data)
 * is preserved byte-identical. Returns the input unchanged when it is not a
 * parseable JPEG. Never throws.
 */
export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  try {
    if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return input;
    const out: number[] = [0xff, 0xd8];
    let pos = 2;
    const pushRaw = (from: number, to: number) => {
      for (let i = from; i < to; i++) out.push(input[i] as number);
    };
    while (pos + 1 < input.length) {
      if (input[pos] !== 0xff) break;
      const marker = input[pos + 1] as number;
      // Standalone markers (RSTn, SOI, EOI, TEM) carry no length.
      if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        out.push(0xff, marker);
        pos += 2;
        if (marker === 0xd9) {
          pushRaw(pos, input.length);
          break;
        }
        continue;
      }
      // Start-of-scan: length-prefixed header, then entropy data until EOI.
      // Preserve the header verbatim and copy the remainder untouched.
      if (marker === 0xda) {
        if (pos + 3 >= input.length) break;
        const len = ((input[pos + 2] as number) << 8) | (input[pos + 3] as number);
        pushRaw(pos, pos + 2 + len);
        pushRaw(pos + 2 + len, input.length);
        break;
      }
      if (pos + 3 >= input.length) break;
      const len = ((input[pos + 2] as number) << 8) | (input[pos + 3] as number);
      if (len < 2 || pos + 2 + len > input.length) break;
      const isCom = marker === 0xfe;
      const isApp1 =
        marker === 0xe1 &&
        len >= 8 &&
        input[pos + 4] === 0x45 && // 'E'
        input[pos + 5] === 0x78 && // 'x'
        input[pos + 6] === 0x69 && // 'i'
        input[pos + 7] === 0x66; // 'f'
      if (!isCom && !isApp1) pushRaw(pos, pos + 2 + len);
      pos += 2 + len;
    }
    return Uint8Array.from(out);
  } catch {
    return input;
  }
}

// ── Shared RGBA pipeline (one wasm path, every runtime) ─────────────────────

export interface TransformedUpload {
  file: File;
  branch: ImageTransformBranch;
  width: number;
}

/**
 * Run the matrix on decoded RGBA + the original compressed bytes. The only
 * runtime-specific step is decoding (browsers: canvas; Node: pure-JS
 * codecs) — resize + encode are the shared wasm path in both. Returns the
 * stored bytes, true-extension filename, branch, and output width.
 */
export async function transformRgbaUpload(input: {
  rgba: { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
  kind: ImageKind;
  originalBytes: Uint8Array;
  originalName: string;
  originalMime: string;
}): Promise<{ bytes: Uint8Array; filename: string; mime: string; branch: ImageTransformBranch; width: number }> {
  const { rgba, kind, originalBytes, originalName, originalMime } = input;
  const decision = decideImageTransform({ kind, width: rgba.width });
  switch (decision.branch) {
    case "lossless-webp": {
      const { encodeLosslessWebp } = await import("./imageCodecs.js");
      const bytes = await encodeLosslessWebp(rgba);
      return {
        bytes,
        filename: withTrueExtension(originalName, "webp"),
        mime: "image/webp",
        branch: decision.branch,
        width: rgba.width,
      };
    }
    case "resize-webp-q80": {
      const { resizeRgbaToWidth, encodeLossyWebp } = await import(
        "./imageCodecs.js"
      );
      const target = decision.targetWidth ?? MAX_INGEST_WIDTH;
      const resized = await resizeRgbaToWidth(rgba, target);
      const bytes = await encodeLossyWebp(
        resized,
        Math.round(LOSSY_WEBP_QUALITY * 100),
      );
      return {
        bytes,
        filename: withTrueExtension(originalName, "webp"),
        mime: "image/webp",
        branch: decision.branch,
        width: resized.width,
      };
    }
    case "keep-jpeg": {
      const bytes = stripJpegMetadata(originalBytes);
      return {
        bytes,
        filename: withTrueExtension(originalName, "jpg"),
        mime: "image/jpeg",
        branch: decision.branch,
        width: rgba.width,
      };
    }
    case "passthrough":
    default:
      return {
        bytes: originalBytes,
        filename:
          decision.outExt.length > 0
            ? withTrueExtension(originalName, decision.outExt)
            : withTrueExtension(originalName, extensionForMime(originalMime)),
        mime: decision.outMime || originalMime || "application/octet-stream",
        branch: "passthrough",
        width: rgba.width,
      };
  }
}

// ── Browser executor (canvas decode + shared wasm pipeline) ─────────────────

/** True when the DOM image pipeline exists (false in jsdom/unit). */
export function hasBrowserImagePipeline(): boolean {
  return typeof Image !== "undefined" && typeof document !== "undefined";
}

/** Best-effort URL cleanup — must never throw (a throw inside an image
 *  event handler would leave the decode promise unsettled forever). */
function safeRevoke(url: string): void {
  try {
    URL.revokeObjectURL?.(url);
  } catch {
    /* partial-DOM runtimes (jsdom stubs) may lack it */
  }
}

/** Decode an image blob to RGBA via canvas (never taints: blob URLs). */
function decodeBlobToRgba(blob: Blob): Promise<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
}> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas unavailable");
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        safeRevoke(url);
        resolve({
          data: pixels.data,
          width: pixels.width,
          height: pixels.height,
        });
      } catch (err) {
        safeRevoke(url);
        reject(err);
      }
    };
    img.onerror = () => {
      safeRevoke(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

/**
 * Run the matrix on an upload in the browser. Never throws and never drops
 * the bytes: without a DOM, without configured wasm, or when any step
 * fails, the raw blob is kept with a matching true extension.
 *
 * `opts.loadWasmBytes` overrides the globally configured wasm source
 * (tests); entries configure once via `configureImageCodecs` /
 * `configureWasmBaseUrl` from `./imageCodecs.js`.
 */
export async function transformImageForUpload(
  blob: Blob,
  originalName: string,
  opts?: { loadWasmBytes?: import("./imageCodecs.js").WasmBytesLoader },
): Promise<TransformedUpload> {
  const kind = classifyImageUpload({
    mimeType: blob.type,
    filename: originalName,
  });
  const keepRaw = (ext: string, branch: ImageTransformBranch, width: number) =>
    ({
      file: new File([blob], withTrueExtension(originalName, ext), {
        type: blob.type || "application/octet-stream",
      }),
      branch,
      width,
    }) satisfies TransformedUpload;

  // Animation, vectors, and unknown kinds are never decoded or touched.
  if (kind === "gif" || kind === "svg" || kind === "other") {
    return keepRaw(extensionForMime(blob.type), "passthrough", 0);
  }
  if (!hasBrowserImagePipeline()) {
    return keepRaw(extensionForMime(blob.type), "passthrough", 0);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (opts?.loadWasmBytes) {
    const { configureImageCodecs } = await import("./imageCodecs.js");
    configureImageCodecs({ loadWasmBytes: opts.loadWasmBytes });
  }

  let rgba: { data: Uint8ClampedArray; width: number; height: number };
  try {
    rgba = await decodeBlobToRgba(blob);
  } catch {
    return keepRaw(extensionForMime(blob.type), "passthrough", 0);
  }

  // Narrow JPEG could not be decided without dims — decide now on real
  // pixels (bytes already in hand for the strip).
  try {
    const out = await transformRgbaUpload({
      rgba,
      kind,
      originalBytes: bytes,
      originalName,
      originalMime: blob.type,
    });
    // Copy into ArrayBuffer-backed bytes: wasm/emscripten output can ride
    // on SharedArrayBuffer-backed memory, which File rejects.
    const owned = new Uint8Array(out.bytes.byteLength);
    owned.set(out.bytes);
    return {
      file: new File([owned], out.filename, {
        type: out.mime,
      }),
      branch: out.branch,
      width: out.width,
    };
  } catch {
    return keepRaw(extensionForMime(blob.type), "passthrough", rgba.width);
  }
}
