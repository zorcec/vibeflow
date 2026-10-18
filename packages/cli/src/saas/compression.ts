/**
 * Upload-side compression for text artifacts pushed to the remote service.
 *
 * Thin wrapper over `@vibeflow-tools/shared` compression policy — the
 * eligibility set, quality, and shrink rule live there, so this file
 * carries no independent rules to drift. (It previously excluded
 * `baseline-*.json`; that exclusion was dropped to match the server,
 * which has compressed baselines since ticket 7a2df818.)
 *
 * Eligible text files are brotli-compressed (quality 5, `node:zlib`, zero
 * dependencies) BEFORE upload, so the bytes on the wire are already the
 * at-rest form the server stores. The server recognizes the upload via
 * the `x-content-encoding: br` header sent alongside `x-filename` and
 * stores the received bytes verbatim — one encode total, zero server CPU.
 *
 * Local files stay plain (git-diffable); this module only shapes the
 * upload payload.
 */
import { brotliCompressSync, constants } from "node:zlib";
import {
  BROTLI_ENCODING,
  BROTLI_QUALITY,
  isCompressibleTextArtifact as isEligible,
  shouldStoreCompressed,
} from "@vibeflow-tools/shared/compression";

/** Marker the server records for brotli-compressed rows. */
export const UPLOAD_ENCODING_BROTLI = BROTLI_ENCODING;

/** Brotli quality for upload compression (matches the at-rest quality). */
export const BROTLI_UPLOAD_QUALITY: number = BROTLI_QUALITY;

/** Whether a filename is eligible for brotli compression on upload. */
export function isCompressibleTextArtifact(filename: string): boolean {
  return isEligible(filename);
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
  if (!isEligible(filename)) {
    return { bytes: input, contentEncoding: null };
  }
  const compressed = brotliCompressSync(input, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
    },
  });
  if (!shouldStoreCompressed(input.length, compressed.length)) {
    return { bytes: input, contentEncoding: null };
  }
  return { bytes: compressed, contentEncoding: UPLOAD_ENCODING_BROTLI };
}
