'use client';
import React from 'react';
import { Dialog } from '../../primitives';

/**
 * ModalBase — the board's modal shell, now a THIN WRAPPER over `Dialog`.
 *
 * P14.1: the hand-rolled portal (bare `createPortal` to `document.body`, no
 * focus trap, no scroll lock, no focus restore) is gone. Behaviour lives in
 * Base UI's Dialog via the primitive, so Escape, the focus trap, focus
 * restore and `aria-modal` are no longer this component's to get wrong.
 *
 * The name and the prop surface stay as they were: `vibeflow-private/docs/specs/
 * ui-instructions.md` tells contributors that modals must use `ModalBase` /
 * `ConfirmModal`, and that instruction is only true if the names survive.
 */
export interface ModalBaseProps {
  open: boolean;
  onClose: () => void;
  /** Header icon rendered inline with title. */
  icon?: React.ReactNode;
  title?: string;
  /** Extra elements on the right side of the header (e.g. close button). */
  headerActions?: React.ReactNode;
  /** Width override for the modal box. Default: min(420px, 95vw). */
  width?: string;
  /** Max height of the modal box. */
  maxHeight?: string;
  /** Optional id for the modal box. */
  id?: string;
  children: React.ReactNode;
  /** Footer content. Rendered in a bottom bar with top border. */
  footer?: React.ReactNode;
  /** Additional inline styles for the modal box. */
  boxStyle?: React.CSSProperties;
  /** Extra keyboard handler (e.g. Enter to confirm). */
  onKeyDown?: (e: KeyboardEvent) => void;
  /** Portal target — the overlay passes its shadow root (P7 isolation contract). */
  container?: HTMLElement | null;
  /** Outside click closes. Destructive confirms usually pass false. */
  closeOnOutsideClick?: boolean;
  /** Extra classes for the modal body. */
  bodyClassName?: string;
  /** Inline style for the modal body. */
  bodyStyle?: React.CSSProperties;
}

export function ModalBase({
  open,
  onClose,
  icon,
  title,
  headerActions,
  width,
  maxHeight,
  id,
  children,
  footer,
  boxStyle,
  onKeyDown,
  container,
  closeOnOutsideClick = true,
  bodyClassName,
  bodyStyle,
}: ModalBaseProps) {
  // Escape is guaranteed here as well as in Dialog.
  //
  // MEASURED (P14.1): Base UI's Dialog only closes on Escape when the event
  // reaches its own handler — the board's existing tests dispatch it on
  // `window` (`fireEvent.keyDown(window, { key: 'Escape' })`), which never
  // reaches the popup, so the modal stayed open and Cancel was never called.
  // The guard ref keeps a single Escape from closing twice when Base UI DOES
  // handle it.
  const escapeHandledRef = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        escapeHandledRef.current = true;
        onClose();
        return;
      }
      onKeyDown?.(e);
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      escapeHandledRef.current = false;
    };
  }, [open, onClose, onKeyDown]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        // Our window listener already closed this one (Escape): do not call
        // onClose twice for a single keypress.
        if (escapeHandledRef.current) {
          escapeHandledRef.current = false;
          return;
        }
        onClose();
      }}
      title={title ?? ''}
      icon={icon}
      headerActions={headerActions}
      id={id}
      container={container}
      footer={footer}
      closeOnOutsideClick={closeOnOutsideClick}
      style={{ width: width ?? 'min(420px, 95vw)', maxHeight, ...boxStyle }}
      bodyClassName={bodyClassName}
      bodyStyle={bodyStyle}
    >
      {children}
    </Dialog>
  );
}
