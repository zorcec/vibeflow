/**
 * Shared compression policy for text task artifacts (CLI uploads +
 * server at-rest storage).
 *
 * SINGLE SOURCE OF TRUTH: the compressible-extension set, the brotli
 * quality, the eligibility rule, and the shrink rule live here and ONLY
 * here. Both the CLI uploader (`packages/cli/src/saas/compression.ts`)
 * and the server store (`packages/web/src/server/storage/compression.ts`)
 * implement their thin wrappers on top of these — fix a rule once, here.
 *
 * Deliberately dependency- and runtime-free (no `node:zlib`, no Buffer):
 * this module is imported by browser-bundled surfaces through the shared
 * barrel, so the actual brotli calls stay in the Node-only wrappers.
 *
 * Baselines ARE eligible (`baseline-*.json` included): they are the largest
 * text artifacts in the store (~1.3 MB raw for a page baseline) and the
 * server persists them compressed (ticket 7a2df818 lifted the old
 * exclusion). Any new `BASELINE_JSON_RE`-style carve-out must be justified
 * against that ticket, not re-added silently.
 */

/** Marker recorded for brotli-compressed bytes (DB `content_encoding`, `x-content-encoding` header value). */
export const BROTLI_ENCODING = "br" as const;

/** Brotli quality for artifacts, upload and at rest (owner-approved). */
export const BROTLI_QUALITY = 5;

/** Extensions eligible for brotli compression (lowercase, no dot). */
export const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "html",
  "htm",
  "txt",
  "csv",
  "json",
]);

/**
 * Whether a filename is eligible for brotli compression.
 * Extension-based; images and extensionless names are never eligible.
 */
export function isCompressibleTextArtifact(filename: string): boolean {
  const base = filename.split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return COMPRESSIBLE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Shrink rule: keep the compressed form only when it actually shrinks.
 * Operates on lengths so wrappers never duplicate the comparison.
 */
export function shouldStoreCompressed(
  originalBytes: number,
  compressedBytes: number,
): boolean {
  return compressedBytes < originalBytes;
}
