import { useEffect } from "react";

interface KeyboardShortcutsOptions {
  /** Called when Alt+H or Ctrl+Shift+V is pressed. */
  onToggleUi: () => void;
}

/**
 * Registers global keyboard shortcuts for the prototyping system.
 *
 * | Shortcut       | Action                         |
 * |----------------|--------------------------------|
 * | Alt + H        | Toggle all switchers           |
 * | Ctrl+Shift+V   | Toggle all switchers           |
 */
export function useKeyboardShortcuts({
  onToggleUi,
}: KeyboardShortcutsOptions): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Alt+H — toggle UI visibility
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === "h") {
        e.preventDefault();
        onToggleUi();
        return;
      }
      // Ctrl+Shift+V — toggle UI visibility
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key === "V") {
        e.preventDefault();
        onToggleUi();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onToggleUi]);
}
