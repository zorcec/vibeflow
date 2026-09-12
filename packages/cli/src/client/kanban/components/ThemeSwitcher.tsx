/**
 * CLI-kanban-only theme switcher, mounted from the CLI kanban App through
 * `SettingsModal`'s `appearance` slot. Keeping it behind a slot means no other
 * consumer of the shared modal renders theme UI it did not ask for.
 *
 * The option list comes from the shared THEME_REGISTRY, so shipping a new theme
 * is one registry entry + one token block — this component never needs editing.
 * Labels, descriptions and preview swatches are all registry data; the icon is
 * only a fallback for entries without swatches.
 *
 * All persistence/application goes through the shared resolver in
 * `@vibeflow-tools/ui/kanban` (setStoredTheme / clearStoredTheme / applyTheme).
 * A concrete theme is stored under THEME_STORAGE_KEY; "System" is a real,
 * selectable option that CLEARS the key so the themes.css
 * `@media (prefers-color-scheme)` fallback decides again.
 */
import React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  THEME_REGISTRY,
  applyTheme,
  clearStoredTheme,
  getStoredTheme,
  getThemeDefinition,
  setStoredTheme,
  type Theme,
  type ThemeDefinition,
} from "@vibeflow-tools/ui/kanban";

/** A user choice: a concrete theme, or "system" (= no stored preference). */
export type ThemePreference = "system" | Theme;

/** Not a registry theme: "system" clears the key so the media query wins. */
const SYSTEM_META: ThemeDefinition = {
  id: "system",
  name: "System",
  description: "Follows your OS setting.",
  base: "dark",
  preview: [],
};

/** System first, then the registry order — one list, no drift. */
export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  ...THEME_REGISTRY.map((entry) => entry.id),
];

function metaFor(preference: ThemePreference): ThemeDefinition {
  return preference === "system"
    ? SYSTEM_META
    : getThemeDefinition(preference);
}

/** Registry preview colours as a small swatch grid (the theme's identity). */
function ThemeSwatches({ preview }: { preview: readonly string[] }) {
  if (preview.length === 0) return null;
  return (
    <span className="theme-option-preview" aria-hidden="true">
      {preview.map((color, index) => (
        <span
          key={`${color}-${index}`}
          className="theme-option-swatch"
          style={{ background: color }}
        />
      ))}
    </span>
  );
}

/** System gets the monitor glyph; themes get swatches, or an ink-scale glyph
 *  when a registry entry ships no preview. */
function ThemeGlyph({
  meta,
  isSystem,
}: {
  meta: ThemeDefinition;
  isSystem: boolean;
}) {
  if (isSystem) return <Monitor style={{ width: 14, height: 14 }} />;
  if (meta.preview.length > 0) return <ThemeSwatches preview={meta.preview} />;
  return meta.base === "light" ? (
    <Sun style={{ width: 14, height: 14 }} />
  ) : (
    <Moon style={{ width: 14, height: 14 }} />
  );
}

/** The persisted choice: a stored theme, or "system" when nothing is stored. */
export function readThemePreference(): ThemePreference {
  return getStoredTheme() ?? "system";
}

/** Persist + apply immediately (no reload). "System" clears storage so the
 *  media query takes over again. */
export function applyThemePreference(preference: ThemePreference): void {
  if (preference === "system") {
    clearStoredTheme();
    applyTheme(null);
    return;
  }
  setStoredTheme(preference);
  applyTheme(preference);
}

export function ThemeSwitcher() {
  const [preference, setPreference] =
    React.useState<ThemePreference>(readThemePreference);
  const groupId = React.useId();
  const hintId = `${groupId}-hint`;

  function select(next: ThemePreference) {
    setPreference(next);
    applyThemePreference(next);
  }

  return (
    <fieldset className="theme-switcher">
      <legend className="dp-meta-label" style={{ marginBottom: 8 }}>
        Theme
      </legend>
      <div className="theme-switcher-options">
        {THEME_PREFERENCES.map((id) => {
          const selected = preference === id;
          const meta = metaFor(id);
          return (
            <label
              key={id}
              className="theme-option"
              data-selected={selected}
              data-theme-option={id}
              data-base={meta.base}
            >
              <input
                type="radio"
                className="theme-option-radio"
                name={groupId}
                value={id}
                checked={selected}
                onChange={() => select(id)}
                aria-describedby={hintId}
              />
              <span className="theme-option-icon">
                <ThemeGlyph meta={meta} isSystem={id === "system"} />
              </span>
              <span className="theme-option-text">
                <span className="theme-option-label">{meta.name}</span>
                <span className="theme-option-hint" title={meta.description}>
                  {meta.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="theme-switcher-hint" id={hintId}>
        System follows your OS. Picking a theme overrides it and is remembered
        across reloads.
      </p>
    </fieldset>
  );
}
