/**
 * CLI-kanban-only theme switcher, mounted from the CLI kanban App through
 * `SettingsModal`'s `appearance` slot (its own "Theme" tab). Keeping it behind
 * a slot means no other consumer of the shared modal renders theme UI it did
 * not ask for.
 *
 * The option list comes from the shared THEME_REGISTRY, so shipping a new theme
 * is one registry entry + one token block — this component never needs editing.
 * The control is deliberately minimal: one compact chip per choice, showing the
 * registry preview swatch and the theme name. Descriptions stay reachable as a
 * native tooltip and the group hint is screen-reader-only, so the picker reads
 * as a tight swatch grid rather than six descriptive rows.
 *
 * All persistence/application goes through the shared resolver in
 * `@vibeflow-tools/ui/kanban` (setStoredTheme / clearStoredTheme / applyTheme).
 * A concrete theme is stored under THEME_STORAGE_KEY; "System" is a real,
 * selectable option that CLEARS the key so the themes.css
 * `@media (prefers-color-scheme)` fallback decides again.
 *
 * Inside the modal the switcher STAGES its choice: selecting applies a DOM-only
 * preview, Apply commits it (persist), and any other dismissal rewinds the DOM
 * and the stored preference to the value the modal opened with. The modal passes
 * that lifecycle in as `ThemeSwitcherProps.slot`; standalone (no slot) the
 * switcher commits immediately as before.
 */
import React from "react";
import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import {
 THEME_REGISTRY,
 applyTheme,
 clearStoredTheme,
 getStoredTheme,
 getThemeDefinition,
 setStoredTheme,
 type AppearanceSlotHandle,
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

/**
 * Tab descriptor for the shared SettingsModal's `appearance` slot. Keeps the
 * "Theme" label and icon in this CLI-only module, so the shared modal stays
 * theme-agnostic.
 */
export const themeSwitcherTab = {
 label: "Theme",
 icon: <Palette className="w-3.5 h-3.5" />,
};

export interface ThemeSwitcherProps {
 /**
  * Lifecycle handle from the Settings modal's `appearance` slot. When present
  * the switcher stages a DOM-only preview until the modal's Apply commits it;
  * Cancel rewinds to the opening preference. Without it the switcher commits
  * immediately, for standalone use.
  */
 slot?: AppearanceSlotHandle;
}

function metaFor(preference: ThemePreference): ThemeDefinition {
 return preference === "system" ? SYSTEM_META : getThemeDefinition(preference);
}

/** Registry preview colours as one 4-quadrant swatch (the theme's identity). */
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
 if (isSystem) return <Monitor style={{ width: 15, height: 15 }} />;
 if (meta.preview.length > 0) return <ThemeSwatches preview={meta.preview} />;
 return meta.base === "light" ? (
  <Sun style={{ width: 15, height: 15 }} />
 ) : (
  <Moon style={{ width: 15, height: 15 }} />
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

/** Apply a preference to the DOM only — the Settings modal's live preview,
 *  committed (persisted) on Apply and rewound on Cancel. */
function previewTheme(preference: ThemePreference): void {
 applyTheme(preference === "system" ? null : preference);
}

/** The preference the modal opened with — what Cancel restores. Cached in the
 *  modal's per-open slot state so a remount (the user visits another tab and
 *  comes back) cannot mistake the current preview for the opening value. */
function openingPreference(slot?: AppearanceSlotHandle): ThemePreference {
 const cached = slot?.state.opening;
 if (cached !== undefined) return cached as ThemePreference;
 const opening = readThemePreference();
 if (slot) slot.state.opening = opening;
 return opening;
}

export function ThemeSwitcher({ slot }: ThemeSwitcherProps) {
 const opening = openingPreference(slot);
 const [preference, setPreference] = React.useState<ThemePreference>(
  () => (slot?.state.pending as ThemePreference | undefined) ?? opening,
 );
 const groupId = React.useId();
 const hintId = `${groupId}-hint`;

 React.useEffect(() => {
  if (!slot) return;
  // The two halves of the modal's footer: Cancel restores what the modal
  // opened with, Apply persists whatever is currently staged.
  slot.registerUndo(() => applyThemePreference(opening));
  slot.registerCommit(() =>
   applyThemePreference(
    (slot.state.pending as ThemePreference | undefined) ?? opening,
   ),
  );
 }, [slot, opening]);

 function select(next: ThemePreference) {
  setPreference(next);
  if (!slot) {
   // Standalone (no Apply/Cancel chrome): commit immediately, as before.
   applyThemePreference(next);
   return;
  }
  slot.state.pending = next;
  previewTheme(next);
 }

 return (
  <fieldset className="theme-switcher">
   {/* Group name for assistive tech; the tab already says "Theme" visibly. */}
   <legend className="theme-switcher-legend">Theme</legend>
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
       title={meta.description}
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
       <span className="theme-option-label">{meta.name}</span>
       {selected && <Check className="theme-option-check" aria-hidden="true" />}
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
