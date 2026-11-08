/**
 * Pixel evidence for `verify --pixels` (ticket 080966d13869639d).
 *
 * Pure math only — no Playwright, no fs, no wasm. The verify engine captures
 * two PNGs of the task selector region (baseline pixels from the first
 * `--pixels` run, after pixels from this run), decodes them with the repo's
 * dependency-free `decodePng` (`src/server/imageNodeCodecs.ts`), and diffs
 * them here. Kept separate from `commands/verify.ts` so the math is unit-
 * testable without launching a browser.
 *
 * What counts as "changed": a pixel changes when ANY of its four channels
 * (RGBA — the "channel" in `PIXEL_DELTA=<max>/255`) differs. Alpha is
 * included: element screenshots carry real transparency (rounded corners,
 * shadows), and a glow change moves coverage as well as colour. Captures are
 * deterministic (same chromium, animations disabled, caret hidden), so equal
 * code produces equal bytes and any nonzero delta is real paint.
 */

/** Evidence filenames. One spelling per concept — the engine, the cleanup
 * exemption, the system-flag set, and the tests all use these. */
export const PIXEL_BASELINE_FILE = "verify-baseline-pixels.png";
export const PIXEL_AFTER_FILE = "verify-after-pixels.png";

/** A decoded image: raw RGBA bytes plus dimensions. */
export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * Outcome of comparing the baseline pixel capture with the after capture.
 * `{max, pct, sameSize}` is the exact `--json` shape `verify --pixels`
 * carries — do not add fields without updating the contract and its tests.
 */
export interface PixelDelta {
  /** Largest per-channel absolute delta, 0-255. 0 when not diffed. */
  max: number;
  /** Share of pixels with any channel different, 1-decimal. 0 when not diffed. */
  pct: number;
  /** False when the captures differ in size — reported, never diffed. */
  sameSize: boolean;
}

/**
 * Diff two decoded captures. Different dimensions are NOT diffed (a shifted
 * layout would read as thousands of changed pixels — garbage, not evidence):
 * the caller reports the mismatch instead.
 */
export function computePixelDelta(
  baseline: RgbaImage,
  after: RgbaImage,
): PixelDelta {
  if (
    baseline.width !== after.width ||
    baseline.height !== after.height
  ) {
    return { max: 0, pct: 0, sameSize: false };
  }
  const total = baseline.width * baseline.height;
  if (total === 0) return { max: 0, pct: 0, sameSize: true };
  let max = 0;
  let changed = 0;
  const a = baseline.data;
  const b = after.data;
  for (let p = 0; p < total; p++) {
    const o = p * 4;
    let pixelChanged = false;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs((a[o + c] as number) - (b[o + c] as number));
      if (d > max) max = d;
      if (d !== 0) pixelChanged = true;
    }
    if (pixelChanged) changed++;
  }
  return { max, pct: Math.round((changed / total) * 1000) / 10, sameSize: true };
}

/** Sizes for the mismatch line — the only context `formatPixelDelta` needs. */
export interface PixelSizes {
  baseline: { width: number; height: number };
  after: { width: number; height: number };
}

/**
 * The one printed line: `PIXEL_DELTA=<max>/255 (<pct>% of pixels changed)`.
 * The `PIXEL_DELTA=` prefix is the greppable contract — tests and agents
 * match on it, so it is never coloured or reworded.
 */
export function formatPixelDelta(
  delta: PixelDelta,
  sizes?: PixelSizes,
): string {
  if (!delta.sameSize) {
    const dims = sizes
      ? ` ${sizes.baseline.width}x${sizes.baseline.height} vs ${sizes.after.width}x${sizes.after.height}`
      : "";
    return `PIXEL_DELTA=unknown/255 (size mismatch${dims} — not diffed)`;
  }
  const pct = Number.isInteger(delta.pct) ? String(delta.pct) : delta.pct.toFixed(1);
  return `PIXEL_DELTA=${delta.max}/255 (${pct}% of pixels changed)`;
}

/**
 * Whether `--min-pixel-delta <n>` is satisfied. The default 0 reports only
 * and never fails on its own; a positive threshold demands a visible change
 * (same size AND max delta at or above it). No baseline yet (undefined delta,
 * e.g. capture failed) never satisfies a positive demand.
 */
export function pixelDemandMet(
  delta: PixelDelta | undefined,
  minPixelDelta: number,
): boolean {
  if (minPixelDelta <= 0) return true;
  if (!delta || !delta.sameSize) return false;
  return delta.max >= minPixelDelta;
}
