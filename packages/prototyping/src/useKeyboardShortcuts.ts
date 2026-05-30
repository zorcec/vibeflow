import { useEffect } from "react";

/** Default keyboard shortcuts for toggling the variant UI. */
export interface KeyboardShortcut {
  /** The key value (e.g. "h", "V"). Case-sensitive for Ctrl+Shift combos. */
  key: string;
  /** Whether Alt must be held. */
  alt?: boolean;
  /** Whether Ctrl must be held. */
  ctrl?: boolean;
  /** Whether Shift must be held. */
  shift?: boolean;
  /** Whether Meta (Cmd/Win) must be held. */
  meta?: boolean;
}

export interface KeyboardShortcutsOptions {
  /** Called when a toggle shortcut is pressed. */
  onToggleUi: () => void;
  /**
   * Custom shortcut definitions. Defaults to [Alt+H, Ctrl+Shift+V].
   * Set to `false` to disable all keyboard shortcuts.
   */
  shortcuts?: KeyboardShortcut[] | false;
}

const DEFAULT_SHORTCUTS: KeyboardShortcut[] = [
  { key: "h", alt: true },
  { key: "V", ctrl: true, shift: true },
];

function matchesShortcut(e: KeyboardEvent, shortcut: KeyboardShortcut): boolean {
  if (e.key !== shortcut.key) return false;
  if (!!shortcut.alt !== e.altKey) return false;
  if (!!shortcut.ctrl !== e.ctrlKey) return false;
  if (!!shortcut.shift !== e.shiftKey) return false;
  if (!!shortcut.meta !== e.metaKey) return false;
  return true;
}

/**
 * Registers global keyboard shortcuts for the prototyping system.
 *
 * | Default Shortcut | Action               |
 * |------------------|----------------------|
 * | Alt + H          | Toggle all switchers |
 * | Ctrl+Shift+V     | Toggle all switchers |
 *
 * Shortcuts can be customized via the `shortcuts` option, or disabled
 * entirely by passing `false`.
 */
export function useKeyboardShortcuts({
  onToggleUi,
  shortcuts = DEFAULT_SHORTCUTS,
}: KeyboardShortcutsOptions): void {
  useEffect(() => {
    if (shortcuts === false) return;

    const handler = (e: KeyboardEvent): void => {
      for (const shortcut of shortcuts) {
        if (matchesShortcut(e, shortcut)) {
          e.preventDefault();
          onToggleUi();
          return;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onToggleUi, shortcuts]);
}
