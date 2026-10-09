/**
 * Upload-side compression for text artifacts pushed to the remote service.
 *
 * Eligible text files (md, html, non-baseline json, txt, csv — never
 * `baseline-*.json`, never images) are brotli-compressed (quality 5,
 * `node:zlib`, zero dependencies) BEFORE upload, so the bytes on the wire
 * are already the at-rest form the server stores. The server recognizes the
 * upload via the `x-content-encoding: br` header sent alongside `x-filename`
 * and stores the received bytes verbatim — one encode total, zero server CPU.
 *
 * Local files stay plain (git-diffable); this module only shapes the upload
 * payload. Eligibility mirrors the server's storage rules exactly, so a file
 * the server would store plain is never sent with the header.
 */
import { brotliCompressSync, constants } from "node:zlib";

/** Marker the server records for brotli-compressed rows. */
export const UPLOAD_ENCODING_BROTLI = "br" as const;

/** Brotli quality for upload compression (matches the at-rest quality). */
export const BROTLI_UPLOAD_QUALITY = 5;

const COMPRESSIBLE_EXTENSIONS = new Set([
  "md",
  "markdown",
  "html",
  "htm",
  "txt",
  "csv",
  "json",
]);

/** Owned by the baselines flow — never compressed here. */
const BASELINE_JSON_RE = /^baseline-.*\.json$/i;

/**
 * Whether a filename is eligible for brotli compression on upload.
 * Extension-based; images and `baseline-*.json` are excluded.
 */
export function isCompressibleTextArtifact(filename: string): boolean {
  const base = filename.split("/").pop() ?? filename;
  if (BASELINE_JSON_RE.test(base)) return false;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return COMPRESSIBLE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Compress `input` for upload when it pays off. Returns the payload bytes
 * plus the `x-content-encoding` header value (`"br"` or `null` for plain).
 * Ineligible names, and inputs that do not shrink, stay plain so small
 * files never grow.
 */
export function maybeCompressForUpload(
  filename: string,
  input: Buffer,
): { bytes: Buffer; contentEncoding: "br" | null } {
  if (!isCompressibleTextArtifact(filename)) {
    return { bytes: input, contentEncoding: null };
  }
  const compressed = brotliCompressSync(input, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_UPLOAD_QUALITY,
    },
  });
  if (compressed.length >= input.length) {
    return { bytes: input, contentEncoding: null };
  }
  return { bytes: compressed, contentEncoding: UPLOAD_ENCODING_BROTLI };
}
