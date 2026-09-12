/**
 * CLI-kanban-only theme switcher, mounted from the CLI kanban App through
 * `SettingsModal`'s `appearance` slot. Keeping it behind a slot means no other
 * consumer of the shared modal renders theme UI it did not ask for.
 *
 * All persistence/application goes through the shared resolver in
 * `@vibeflow-tools/ui/kanban` (setStoredTheme / clearStoredTheme / applyTheme).
 * A concrete theme is stored under THEME_STORAGE_KEY; "System" is a real,
 * selectable option that CLEARS the key so the themes.css
 * `@media (prefers-color-scheme)` fallback decides again.
 */
import React from "react";
import { Contrast, Monitor, Moon, Sun } from "lucide-react";
import {
  THEMES,
  applyTheme,
  clearStoredTheme,
  getStoredTheme,
  setStoredTheme,
  type Theme,
} from "@vibeflow-tools/ui/kanban";

/** A user choice: a concrete theme, or "system" (= no stored preference). */
export type ThemePreference = "system" | Theme;

/** System first, then the shared THEMES order — one list, no drift. */
export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  ...THEMES,
];

const LABELS: Record<ThemePreference, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
  "hc-dark": "High contrast",
};

const HINTS: Record<ThemePreference, string> = {
  system: "Follows your OS setting",
  dark: "Dark board, low light",
  light: "Light board, bright rooms",
  "hc-dark": "Maximum legibility",
};

const ICONS: Record<ThemePreference, React.ReactNode> = {
  system: <Monitor style={{ width: 14, height: 14 }} />,
  dark: <Moon style={{ width: 14, height: 14 }} />,
  light: <Sun style={{ width: 14, height: 14 }} />,
  "hc-dark": <Contrast style={{ width: 14, height: 14 }} />,
};

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
          return (
            <label
              key={id}
              className="theme-option"
              data-selected={selected}
              data-theme-option={id}
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
              <span className="theme-option-icon" aria-hidden="true">
                {ICONS[id]}
              </span>
              <span className="theme-option-text">
                <span className="theme-option-label">{LABELS[id]}</span>
                <span className="theme-option-hint">{HINTS[id]}</span>
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
