/**
  * Theme contract — every registered theme must be complete and legible.
  *
  * A theme is data: one THEME_REGISTRY entry plus one `--t-*` token block in
  * themes.css. This test reads the token blocks that actually ship and enforces
  * two rules (see docs/research/theme-palettes.md §6):
  *
  *  1. Completeness — every registered theme resolves the full `--t-*` surface,
  *     and a DATA-ONLY theme (one that declares no `--p-*` primitives, i.e. a
  *     curated theme) must declare every one of those tokens itself. A missing
  *     token fails here instead of silently inheriting another theme's value.
  *     The legacy dark/light/hc-dark blocks resolve the surface through their
  *     `--p-*` primitives, so they are checked by resolution, not by own keys.
  *
  *  2. Contrast — body, status, relation, semantic, syntax and accent tokens
  *     clear WCAG AA (4.5:1) against the card and column surfaces; the
  *     de-emphasised `--t-text-faint`/`--t-text-ghost` tiers clear 3:1.
  */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_REGISTRY, type Theme } from "../theme";

// Read the stylesheet that actually ships. `new URL(..., import.meta.url)` is
// rewritten by Vite into a module URL, so resolve through the real file path.
const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../themes.css"),
  "utf-8",
);

/**
  * The full semantic token vocabulary a theme must provide — the 47 core tokens
  * from the palette spec plus the extended chip/control aliases the components
  * consume. Kept explicit (not derived from the CSS) so deleting a token from a
  * theme can never shrink the contract.
  */
const REQUIRED_TOKENS: readonly string[] = [
    // Surfaces
    "--t-bg",
    "--t-surface",
    "--t-card",
    "--t-card-inset",
    "--t-hover",
    "--t-input",
    "--t-overlay-scrim",
    // Text
    "--t-text",
    "--t-text-sub",
    "--t-text-muted",
    "--t-text-faint",
    "--t-text-ghost",
    "--t-on-accent",
    // Borders
    "--t-border",
    "--t-border-strong",
    "--t-border-faint",
    // Accents
    "--t-accent",
    "--t-accent-hover",
    "--t-accent-soft-bg",
    "--t-accent-soft-border",
    "--t-accent-contrast",
    // Status
    "--t-status-backlog",
    "--t-status-todo",
    "--t-status-progress",
    "--t-status-review",
    "--t-status-done",
    // Relations
    "--t-rel-children",
    "--t-rel-parent",
    "--t-rel-blocks",
    "--t-rel-related",
    // Semantic states
    "--t-success",
    "--t-success-soft",
    "--t-danger",
    "--t-danger-strong",
    "--t-danger-soft",
    "--t-warning",
    "--t-warning-soft",
    "--t-info-soft",
    "--t-agent",
    // Elevation
    "--t-shadow-card",
    "--t-shadow-popover",
    "--t-shadow-modal",
    // Syntax
    "--t-syntax-key",
    "--t-syntax-string",
    "--t-syntax-number",
    "--t-syntax-bool",
    "--t-syntax-null",
    // Extended aliases (chips, controls, readable body tier)
    "--t-accent-strong",
    "--t-accent-soft",
    "--t-accent-subtle",
    "--t-secondary",
    "--t-secondary-soft",
    "--t-cyan",
    "--t-cyan-soft",
    "--t-pink-soft",
    "--t-warning-subtle",
    "--t-success-subtle",
    "--t-white",
    "--t-bg-raised",
    "--t-shadow-lg",
    "--t-text-body",
    "--t-chip-blue-200",
    "--t-chip-blue-300",
    "--t-chip-purple-300",
    "--t-chip-amber-300",
    "--t-chip-amber-400",
    "--t-chip-orange-400",
    "--t-chip-green-300",
    "--t-chip-green-400",
    "--t-chip-pink-300",
    "--t-chip-cyan-300",
    "--t-chip-red-300",
    "--t-chip-slate-400",
    "--t-control-surface",
    "--t-code-bg",
];

/** Text/signal tokens that must clear WCAG AA on the content surfaces. */
const AA_CONTENT_TOKENS: readonly string[] = [
    "--t-text",
    "--t-text-sub",
    "--t-text-muted",
    "--t-status-backlog",
    "--t-status-todo",
    "--t-status-progress",
    "--t-status-review",
    "--t-status-done",
    "--t-rel-children",
    "--t-rel-parent",
    "--t-rel-blocks",
    "--t-rel-related",
    "--t-success",
    "--t-danger",
    "--t-warning",
    "--t-agent",
    "--t-syntax-key",
    "--t-syntax-string",
    "--t-syntax-number",
    "--t-syntax-bool",
    "--t-syntax-null",
    "--t-accent",
    "--t-accent-contrast",
];

const CONTENT_SURFACES: readonly string[] = ["--t-card", "--t-surface"];
const UI_FLOOR_TOKENS: readonly string[] = ["--t-text-faint", "--t-text-ghost"];

/**
  * The dark/light/hc-dark themes shipped before the semantic token tier existed
  * and render several pairs below the contract floors (dark's accent fill is
  * 3.69:1, light's agent colour 3.25:1, both themes' ghost tier ~2.5:1, ...).
  * Requirement 5 forbids changing their token values, so each sub-floor pair is
  * recorded here with its current ratio and the test only requires it not to
  * REGRESS. Curated themes are never listed; a companion test proves it.
  */
const SHIPPED_THEMES: readonly Theme[] = ["dark", "light", "hc-dark"];

const LEGACY_FROZEN_BELOW_FLOOR: Record<string, number> = {
  "dark:--t-accent/--t-card": 3.69,
  "dark:--t-accent/--t-surface": 3.7,
  "dark:--t-on-accent/--t-accent": 3.79,
  "dark:--t-text-ghost/--t-card": 2.52,
  "dark:--t-text-ghost/--t-surface": 2.53,
  "light:--t-status-backlog/--t-surface": 4.34,
  "light:--t-rel-blocks/--t-surface": 4.41,
  "light:--t-danger/--t-surface": 4.41,
  "light:--t-agent/--t-card": 3.56,
  "light:--t-agent/--t-surface": 3.25,
  "light:--t-syntax-null/--t-surface": 4.41,
  "light:--t-text-ghost/--t-card": 2.56,
  "light:--t-text-ghost/--t-surface": 2.34,
};

interface Block {
  selector: string;
  body: string;
  tokens: Record<string, string>;
}

function parseDeclarationBlock(body: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) tokens[match[1]] = match[2].trim();
  return tokens;
}

function parseBlocks(css: string): Block[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Block[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped))) {
    const selector = match[1].trim();
    const body = match[2];
    blocks.push({ selector, body, tokens: parseDeclarationBlock(body) });
  }
  return blocks;
}

const BLOCKS = parseBlocks(CSS);
const ROOT = BLOCKS.find((block) => block.selector === ":root");
if (!ROOT) throw new Error("themes.css has no :root block");

/** The block that actually renders a theme: `:root` is the default dark theme. */
function blockFor(id: Theme): Block {
  if (id === "dark") return ROOT as Block;
  const block = BLOCKS.find((candidate) => candidate.selector === `[data-theme="${id}"]`);
  if (!block) throw new Error(`themes.css declares no block for theme "${id}"`);
  return block;
}

/** A data-only theme overrides semantic tokens but no primitives, so it cannot
  *  lean on :root's primitive aliases and must be complete on its own. */
function isDataOnly(block: Block): boolean {
  return !/--p-[a-z0-9-]+\s*:/.test(block.body);
}

function missingTokens(tokens: Record<string, string>): string[] {
  return REQUIRED_TOKENS.filter((token) => tokens[token] === undefined);
}

/** Resolve `var(--x)` chains for one theme (root defaults overlaid by its block). */
function effectiveTokens(id: Theme): Record<string, string> {
  const overlay = id === "dark" ? {} : blockFor(id).tokens;
  const map: Record<string, string> = { ...(ROOT as Block).tokens, ...overlay };
  const resolve = (value: string, seen: Set<string>): string | null => {
    const trimmed = value.trim();
    const ref = trimmed.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.*))?\)$/i);
    if (!ref) return trimmed;
    if (seen.has(ref[1])) return null;
    seen.add(ref[1]);
    const next = map[ref[1]];
    if (next !== undefined) return resolve(next, seen);
    return ref[2] ? resolve(ref[2], seen) : null;
  };
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    const out = resolve(value, new Set());
    if (out !== null) resolved[name] = out;
  }
  return resolved;
}

type Rgba = readonly [number, number, number, number];

function parseColor(value: string | undefined): Rgba | null {
  if (!value) return null;
  const hex = value.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = digits
        .split("")
        .map((digit) => digit + digit)
        .join("");
    }
    if (digits.length !== 6 && digits.length !== 8) return null;
    const channel = (offset: number) => parseInt(digits.slice(offset, offset + 2), 16);
    const alpha = digits.length === 8 ? channel(6) / 255 : 1;
    return [channel(0), channel(2), channel(4), alpha];
  }
  const rgb = value.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3]];
  }
  return null;
}

function flattenOver(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3];
  return [
    Math.round(foreground[0] * alpha + background[0] * (1 - alpha)),
    Math.round(foreground[1] * alpha + background[1] * (1 - alpha)),
    Math.round(foreground[2] * alpha + background[2] * (1 - alpha)),
    1,
  ];
}

function relativeLuminance(color: Rgba): number {
  const [r, g, b] = color.slice(0, 3).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio, flattening a translucent foreground over its surface. */
function contrastRatio(foreground: string | undefined, background: string | undefined): number | null {
  const front = parseColor(foreground);
  const back = parseColor(background);
  if (!front || !back) return null;
  const opaqueFront = front[3] < 1 ? flattenOver(front, back) : front;
  const l1 = Math.max(relativeLuminance(opaqueFront), relativeLuminance(back));
  const l2 = Math.min(relativeLuminance(opaqueFront), relativeLuminance(back));
  return (l1 + 0.05) / (l2 + 0.05);
}

interface ContrastPair {
  foreground: string;
  background: string;
}

function aaPairs(): ContrastPair[] {
  const pairs: ContrastPair[] = [];
  for (const foreground of AA_CONTENT_TOKENS) {
    for (const background of CONTENT_SURFACES) {
      pairs.push({ foreground, background });
    }
  }
  pairs.push({ foreground: "--t-on-accent", background: "--t-accent" });
  return pairs;
}

/**
  * Assert one pair against its floor. A pair on the legacy freeze list only has
  * to hold its recorded ratio (no regression); everything else must clear the
  * floor outright, so a curated theme can never be quietly exempted.
  */
function assertContrast(
  id: Theme,
  effective: Record<string, string>,
  foreground: string,
  background: string,
  floor: number,
): void {
  const ratio = contrastRatio(effective[foreground], effective[background]);
  expect(ratio, `${id}: ${foreground} on ${background} did not resolve`).not.toBeNull();
  const frozen = LEGACY_FROZEN_BELOW_FLOOR[`${id}:${foreground}/${background}`];
  if (frozen !== undefined) {
    expect(
      ratio,
      `${id}: frozen ${foreground} on ${background} must not regress below ${frozen}`,
    ).toBeGreaterThanOrEqual(frozen - 0.05);
    return;
  }
  expect(
    ratio,
    `${id}: ${foreground} on ${background} = ${(ratio as number).toFixed(2)} (need >= ${floor})`,
  ).toBeGreaterThanOrEqual(floor);
}

describe("theme contract", () => {
  it("lists a themes.css block for every registered theme", () => {
    for (const { id } of THEME_REGISTRY) expect(() => blockFor(id)).not.toThrow();
  });

  it("detects missing tokens (guard is not vacuous)", () => {
    expect(missingTokens({})).toEqual(REQUIRED_TOKENS);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  it("freezes only shipped themes, never a curated one", () => {
    for (const key of Object.keys(LEGACY_FROZEN_BELOW_FLOOR)) {
      const id = key.split(":")[0] as Theme;
      expect(SHIPPED_THEMES, `${key} may only belong to a shipped theme`).toContain(id);
    }
  });

  for (const { id } of THEME_REGISTRY) {
    describe(id, () => {
      it("defines the complete --t-* surface", () => {
        const block = blockFor(id);
        if (isDataOnly(block)) {
          expect(
            missingTokens(block.tokens),
            `${id} is data-only and must declare every token itself`,
          ).toEqual([]);
        }
        const effective = effectiveTokens(id);
        expect(
          missingTokens(effective),
          `${id} must resolve every token to a concrete value`,
        ).toEqual([]);
      });

      it("meets the contrast contract", () => {
        const effective = effectiveTokens(id);
        for (const { foreground, background } of aaPairs()) {
          assertContrast(id, effective, foreground, background, 4.5);
        }
        for (const foreground of UI_FLOOR_TOKENS) {
          for (const background of CONTENT_SURFACES) {
            assertContrast(id, effective, foreground, background, 3);
          }
        }
      });
    });
  }
});
