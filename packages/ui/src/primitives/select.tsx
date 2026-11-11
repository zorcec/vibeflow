import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../primitives";

/**
 * Select — single-choice listbox.
 *
 * WHY THIS IS NOT BUILT ON BASE UI
 * Base UI's Select was tried first and rejected on evidence (2026-11-11):
 *  - ArrowDown opens the listbox, but ArrowDown-highlight and Enter-commit
 *    never fired, in jsdom *and* in the real browser story runner;
 *  - its `Item` rejects an `id` prop, so `aria-activedescendant` — which the
 *    requirement names explicitly — could not point at a valid option.
 * Rather than ship a control whose keyboard model is a promise, the roles,
 * `aria-activedescendant`, typeahead and commit logic are implemented here,
 * where they are unit-testable.
 *
 * KNOWN LIMITATION, stated plainly: the popup is positioned below the trigger
 * with CSS and does not do viewport collision flipping. Closing that gap is
 * tracked separately; the listbox is capped in height so it stays usable.
 */
export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  /** Currently selected value, or `null` for none. */
  value: string | null;
  /** Called with the new value when the user selects an option. */
  onValueChange: (value: string) => void;
  /** Flat option list. */
  options: readonly SelectOption[];
  /** Shown when `value` is null. */
  placeholder?: string;
  /** Disable the whole control. */
  disabled?: boolean;
  /** Portal target for the popup. Defaults to `document.body`; the overlay passes its shadow root. */
  container?: HTMLElement | null;
  /** Custom trigger content instead of the selected option's label. */
  renderValue?: (option: SelectOption | null) => ReactNode;
  /** Extra classes for the trigger. */
  className?: string;
  /** Accessible name when no visible label is associated. */
  "aria-label"?: string;
  /** Id of a visible label. */
  id?: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  disabled = false,
  container,
  renderValue,
  className,
  "aria-label": ariaLabel,
  id,
}: SelectProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const enabled = options.filter((option) => !option.disabled);
  const selected = options.find((option) => option.value === value) ?? null;
  const selectedIndex = enabled.findIndex((option) => option.value === value);
  const [highlight, setHighlight] = useState(selectedIndex >= 0 ? selectedIndex : 0);
  const typeahead = useRef({ buffer: "", at: 0 });

  const optionId = (optionValue: string) => `${listboxId}-opt-${optionValue}`;
  const highlighted = enabled[highlight] ?? null;

  // Opening resets the highlight to the selected option (or the first one).
  useEffect(() => {
    if (!open) return;
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  // Outside click closes without committing — same contract as Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      const listbox = document.getElementById(listboxId);
      if (listbox?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, listboxId]);

  const commit = (option: SelectOption | null) => {
    if (!option || option.disabled) return;
    onValueChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const { key } = event;

    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlight((h) => Math.min(h + 1, enabled.length - 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      case "Home":
        event.preventDefault();
        setHighlight(0);
        return;
      case "End":
        event.preventDefault();
        setHighlight(enabled.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(highlighted);
        return;
      case "Escape":
        event.preventDefault();
        // Explicitly: close WITHOUT changing the value.
        setOpen(false);
        return;
      case "Tab":
        setOpen(false);
        return;
      default: {
        if (key.length !== 1) return;
        const now = Date.now();
        const state = typeahead.current;
        state.buffer =
          now - state.at > 800 ? key.toLowerCase() : state.buffer + key.toLowerCase();
        state.at = now;
        const match = enabled.findIndex((option) =>
          String(option.label).toLowerCase().startsWith(state.buffer),
        );
        if (match >= 0) setHighlight(match);
      }
    }
  };

  const popup = open ? (
    <div
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      data-role="select-popup"
      className="absolute z-50 mt-1 max-h-64 w-full min-w-48 overflow-y-auto rounded-md border border-border bg-bg-raised p-1 shadow-popover"
    >
      {options.length === 0 ? (
        <p className="px-2 py-1 text-sm text-text-muted">No options</p>
      ) : (
        options.map((option) => (
          <div
            key={option.value}
            id={optionId(option.value)}
            role="option"
            aria-selected={option.value === value}
            aria-disabled={option.disabled || undefined}
            data-role="select-option"
            data-highlighted={
              highlighted?.value === option.value ? "" : undefined
            }
            className="flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-sm text-text data-highlighted:bg-hover aria-selected:font-semibold aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onPointerEnter={() => {
              const index = enabled.findIndex((o) => o.value === option.value);
              if (index >= 0) setHighlight(index);
            }}
            onClick={() => commit(option)}
          >
            <span>{option.label}</span>
            {option.value === value ? <span aria-hidden="true">✓</span> : null}
          </div>
        ))
      )}
    </div>
  ) : null;

  return (
    <div className="relative w-full">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && highlighted ? optionId(highlighted.value) : undefined
        }
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        data-role="select-trigger"
        data-disabled={disabled ? "" : undefined}
        className={cn(
          "inline-flex w-full items-center justify-between gap-2 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span data-role="select-value">
          {renderValue ? renderValue(selected) : (selected?.label ?? placeholder)}
        </span>
        <span aria-hidden="true" className="text-text-muted">
          ▾
        </span>
      </button>
      {container ? createPortal(popup, container) : popup}
    </div>
  );
}
