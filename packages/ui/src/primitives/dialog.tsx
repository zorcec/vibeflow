import type { ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";
import { cn } from "../primitives";

/**
 * Dialog — the modal primitive.
 *
 * Behaviour comes from Base UI's Dialog (focus trap, focus restore, Escape,
 * `aria-modal`, scroll lock). Hand-rolling any of that is how modals end up
 * keyboard-trapping users inside a page they cannot leave, so this component
 * deliberately owns no behaviour of its own — only the token-only presentation
 * and the API the board and overlay need.
 *
 * `container` exists because the overlay renders inside a shadow root: a modal
 * portalled to `document.body` would escape the overlay's tokens and styles.
 * Passing the shadow root keeps it inside (this is P7's isolation contract).
 */
export interface DialogProps {
  /** Controlled open state. */
  open: boolean;
  /** Called with `false` on Escape, outside click (when enabled) and Close. */
  onOpenChange: (open: boolean) => void;
  /** Required heading — the dialog's accessible name. */
  title: string;
  /** Optional supporting text, wired to `aria-describedby`. */
  description?: string;
  /** Portal target. Defaults to `document.body`; the overlay passes its shadow root. */
  container?: HTMLElement | null;
  /** Body content. */
  children: ReactNode;
  /** Action row rendered at the bottom, right-aligned. */
  footer?: ReactNode;
  /** Outside click closes. Default true; a destructive confirm usually wants false. */
  closeOnOutsideClick?: boolean;
  /** Extra classes for the popup surface. */
  className?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  container,
  children,
  footer,
  closeOnOutsideClick = true,
  className,
}: DialogProps) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={onOpenChange}
      modal
      disablePointerDismissal={!closeOnOutsideClick}
    >
      <BaseDialog.Portal container={container ?? undefined}>
        <BaseDialog.Backdrop
          data-role="dialog-backdrop"
          className="fixed inset-0 bg-overlay-scrim"
        />
        <BaseDialog.Popup
          // Base UI marks the background inert but does NOT emit aria-modal
          // (measured 2026-11-11: the popup's attributes were role=dialog +
          // aria-labelledby only). The requirement is explicit, so state it.
          aria-modal="true"
          data-role="dialog-popup"
          className={cn(
            "fixed top-1/2 left-1/2 flex max-h-dvh w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-hidden rounded-lg border border-border bg-bg-raised p-5 shadow-card",
            className,
          )}
        >
          <BaseDialog.Title className="text-base font-semibold text-text">
            {title}
          </BaseDialog.Title>
          {description ? (
            <BaseDialog.Description className="text-sm text-text-muted">
              {description}
            </BaseDialog.Description>
          ) : null}
          {/* tabIndex: axe `scrollable-region-focusable` — a scrollable box that
              cannot take keyboard focus strands keyboard users on long content. */}
          <div
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain text-sm text-text"
          >
            {children}
          </div>
          {footer ? (
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              {footer}
            </div>
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
