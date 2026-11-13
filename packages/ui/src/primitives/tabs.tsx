import React from "react";
import { useRef, type ReactNode } from "react";
import { Tabs as BaseTabs } from "@base-ui-components/react/tabs";
import { cn } from "../primitives";

/**
 * Tabs — tablist + panels.
 *
 * Roles (`tablist`/`tab`/`tabpanel`), `aria-controls`/`aria-labelledby`, roving
 * tabindex and the arrow-key model come from Base UI.
 *
 * ACTIVATION MODE IS OURS, NOT BASE UI'S
 * Base UI's Tabs activates on arrow focus only (automatic). The detail panel's
 * activity feed is expensive, so this component also offers `manual`: arrows
 * move focus and Enter/Space commits. Base UI reports every arrow move through
 * `onValueChange`, so in manual mode those reports are held until an explicit
 * commit (Enter, Space or a click) — otherwise "manual" would be a label with
 * no behaviour behind it.
 */
export interface TabDefinition {
  id: string;
  label: ReactNode;
  panel: ReactNode;
  disabled?: boolean;
}

export type TabsActivationMode = "automatic" | "manual";
export type TabsOrientation = "horizontal" | "vertical";

export interface TabsProps {
  /** Active tab id. */
  value: string;
  /** Called when the user activates a different tab. */
  onValueChange: (value: string) => void;
  /** Tab definitions, in visual order. */
  tabs: readonly TabDefinition[];
  /** Arrow-key activation model. Defaults to `automatic`. */
  activationMode?: TabsActivationMode;
  /** Arrow axis. Defaults to `horizontal`. */
  orientation?: TabsOrientation;
  /** Extra classes for the tablist. */
  className?: string;
  /** Accessible name for the tablist. */
  "aria-label"?: string;
}

export function Tabs({
  value,
  onValueChange,
  tabs,
  activationMode = "automatic",
  orientation = "horizontal",
  className,
  "aria-label": ariaLabel,
}: TabsProps) {
  /** Tab that focus landed on but that has not been committed (manual mode). */
  const pendingRef = useRef<string | null>(null);
  /** Set while handling a real click, which always commits in manual mode. */
  const clickingRef = useRef(false);

  const manual = activationMode === "manual";

  return (
    <BaseTabs.Root
      value={value}
      onValueChange={(next) => {
        const target = next as string;
        if (!manual) {
          onValueChange(target);
          return;
        }
        // Manual: hold arrow-driven changes until an explicit commit.
        if (clickingRef.current) {
          clickingRef.current = false;
          pendingRef.current = null;
          onValueChange(target);
          return;
        }
        pendingRef.current = target;
      }}
      orientation={orientation}
    >
      <BaseTabs.List
        aria-label={ariaLabel}
        data-role="tablist"
        className={cn(
          "flex gap-1 border-b border-border",
          orientation === "vertical" && "flex-col border-b-0 border-l",
          className,
        )}
        onKeyDown={(event) => {
          // OWN the arrow model: Base UI's tabs did not activate on
          // ArrowRight/ArrowDown in the browser (measured 2026-11-11: the
          // panel never changed), so navigation is implemented here where it
          // can also be tested.
          const enabled = tabs
            .map((tab, index) => ({ tab, index }))
            .filter((entry) => !entry.tab.disabled);
          // Every tab disabled: nowhere to go — and `% 0` would be NaN,
          // making `enabled[NaN]` undefined and moveTo dereference
          // `target.tab.id` on undefined.
          if (enabled.length === 0) return;

          // Origin is the tab focus is ON, not the committed `value`: in
          // manual mode (and before the parent re-renders) `value` never
          // moves, so measuring from it would recompute the same neighbour
          // on every press and focus would never advance.
          const activeEl = document.activeElement as HTMLElement | null;
          const focused = activeEl?.getAttribute("data-tab-value");
          const currentIndex = tabs.findIndex(
            (tab) => tab.id === (focused ?? pendingRef.current ?? value),
          );

          const step = (delta: number) => {
            let index = currentIndex;
            for (let visited = 0; visited < tabs.length; visited += 1) {
              index = (index + delta + tabs.length) % tabs.length;
              if (!tabs[index].disabled) return tabs[index];
            }
            return undefined; // unreachable: enabled.length > 0
          };

          const moveTo = (target: TabDefinition) => {
            event.preventDefault();
            const el = event.currentTarget.querySelector<HTMLElement>(
              `[data-tab-value="${target.id}"]`,
            );
            el?.focus();
            if (!manual) {
              onValueChange(target.id);
            } else {
              pendingRef.current = target.id;
            }
          };

          const forward = step(1);
          const backward = step(-1);
          switch (event.key) {
            case "ArrowRight":
            case "ArrowDown":
              if (forward) moveTo(forward);
              return;
            case "ArrowLeft":
            case "ArrowUp":
              if (backward) moveTo(backward);
              return;
            case "Home":
              moveTo(enabled[0].tab);
              return;
            case "End":
              moveTo(enabled[enabled.length - 1].tab);
              return;
            case "Enter":
            case " ": {
              if (!manual) return;
              const target = pendingRef.current ?? focused;
              if (!target || target === value) return;
              event.preventDefault();
              pendingRef.current = null;
              onValueChange(target);
              return;
            }
            default:
              return;
          }
        }}
      >
        {tabs.map((tab) => (
          <BaseTabs.Tab
            key={tab.id}
            value={tab.id}
            disabled={tab.disabled}
            data-role="tab"
            data-tab-value={tab.id}
            onClick={() => {
              if (manual) clickingRef.current = true;
            }}
            className="rounded-t border-b-2 border-transparent px-3 py-1.5 text-sm text-text-muted transition-colors data-selected:border-accent data-selected:text-text data-disabled:cursor-not-allowed data-disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {tab.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {tabs.map((tab) => (
        <BaseTabs.Panel
          key={tab.id}
          value={tab.id}
          data-role="tabpanel"
          className="pt-3 text-sm text-text"
        >
          {tab.panel}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  );
}
