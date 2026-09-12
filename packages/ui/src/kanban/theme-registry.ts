/**
  * Theme registry — the single source of truth for which themes exist and the
  * display metadata that every consumer reads. A theme is DATA: one entry here
  * plus one `--t-*` token block in themes.css. Adding a theme therefore needs no
  * component edit, and `Theme`/`THEMES` are derived from this list rather than a
  * hand-maintained union.
  *
  * Display fields: `id` (the `data-theme` value), `name`, `description`, `base`
  * (light/dark ink hint) and `preview` (3-4 representative swatch colours). The
  * token map itself lives in themes.css; `__tests__/theme-contract.test.ts`
  * reads that file and fails if a registered theme is missing tokens or drops
  * below a contrast floor.
  */

export type ThemeBase = "dark" | "light";

export interface ThemeDefinition {
  /** Value written to `data-theme` and persisted under THEME_STORAGE_KEY. */
  readonly id: string;
  /** Switcher label. */
  readonly name: string;
  /** One-line character description shown under the label. */
  readonly description: string;
  /** Which ink scale the theme uses (drives the fallback glyph and CSS data-base). */
  readonly base: ThemeBase;
  /** 2-4 representative colours for the switcher swatches. */
  readonly preview: readonly string[];
}

export const THEME_REGISTRY = [
  {
    id: "dark",
    name: "Dark",
    description: "Neutral navy dark for low light.",
    base: "dark",
    preview: ["#020c1b", "#2563eb", "#22c55e", "#f59e0b"],
  },
  {
    id: "light",
    name: "Light",
    description: "Cool light board for bright rooms.",
    base: "light",
    preview: ["#f8fafc", "#1d4ed8", "#15803d", "#b45309"],
  },
  {
    id: "hc-dark",
    name: "High contrast",
    description: "Maximum legibility on true black.",
    base: "dark",
    preview: ["#000000", "#3b82f6", "#4ade80", "#fbbf24"],
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    description:
      "Warm paper light with muted rose, pine and iris accents.",
    base: "light",
    preview: ["#faf4ed", "#286983", "#b4637a", "#ea9d34"],
  },
  {
    id: "dracula",
    name: "Dracula",
    description:
      "Violet-forward dark with high-saturation accents on charcoal.",
    base: "dark",
    preview: ["#282a36", "#bd93f9", "#ff79c6", "#50fa7b"],
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    description:
      "Warm retro dark with high-contrast syntax and an orange/aqua accent pair.",
    base: "dark",
    preview: ["#1d2021", "#fbf1c7", "#fe8019", "#83a598"],
  },
] as const satisfies readonly ThemeDefinition[];

/** A registered theme id. Derived from the registry, never hand-maintained. */
export type Theme = (typeof THEME_REGISTRY)[number]["id"];

/** Canonical theme order; also the validation list. */
export const THEMES: readonly Theme[] = THEME_REGISTRY.map((entry) => entry.id);

/** Fallback used when a concrete theme is required. The rendered default is
  *  still driven by themes.css :root (dark) plus the prefers-color-scheme
  *  media query, so `resolveInitialTheme()` returns null until the user has an
  *  explicit preference. */
export const DEFAULT_THEME: Theme = "dark";

const DEFINITIONS_BY_ID = new Map<string, ThemeDefinition>(
  THEME_REGISTRY.map((entry) => [entry.id, entry]),
);

/** Display metadata for a registered theme. Throws on an unknown id. */
export function getThemeDefinition(id: Theme): ThemeDefinition {
  const definition = DEFINITIONS_BY_ID.get(id);
  if (!definition) throw new Error(`Unknown theme: ${id}`);
  return definition;
}
