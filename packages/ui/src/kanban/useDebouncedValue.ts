import React from "react";
import { SEARCH_DEBOUNCE_MS } from "./search";

/**
 * Trailing-edge debounce for a value (ticket 46e05c7b): returns `value`
 * immediately on first render, then lags `delayMs` behind it — the timer
 * restarts on every change, so rapid keystrokes settle to ONE update.
 */
export function useDebouncedValue<T>(
  value: T,
  delayMs: number = SEARCH_DEBOUNCE_MS,
): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
