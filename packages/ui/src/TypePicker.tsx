import React from 'react';
import ReactDOM from 'react-dom';
import { TASK_TYPES } from './task-types';
import type { TaskType } from './task-types';
import { computePopoverPosition } from './kanban/task-links';

interface Props {
  id?: string;
  value: TaskType | string | null | undefined;
  onChange: (value: TaskType) => void;
  disabled?: boolean;
  /**
   * In-field variant (c94cde70): the trigger renders borderless with a
   * trailing divider so it can sit INSIDE a wrapping field (the detail
   * panel's title input) and read as part of that field rather than a
   * detached widget. The default trigger styling is unchanged.
   */
  bare?: boolean;
}

// ── TypePicker ────────────────────────────────────────────────────────────────
// Inline-styled dropdown for choosing task type. Works in both CLI (via CSS class
// passthrough) and SaaS (inline styles). The current type is displayed as an icon
// + label; clicking opens a compact option list.
export function TypePicker({ id, value, onChange, disabled, bare }: Props) {
  const [open, setOpen] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  // Viewport-anchored rect for the body portal (c94cde70): captured from
  // the trigger whenever the menu opens, so the portal can anchor to it.
  const [anchorRect, setAnchorRect] = React.useState<DOMRect | null>(null);
  const current = TASK_TYPES.find((t) => t.value === value) ?? TASK_TYPES[0];

  const openMenu = React.useCallback(() => {
    if (typeof window !== 'undefined' && buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setOpen(true);
  }, []);
  const closeMenu = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  // Escape closes the menu. Scroll/resize close it too — same contract as
  // ChildPopover and the badge overflow tip — so the fixed portal never
  // floats detached from its trigger. Escape is captured and stopped: the
  // board closes the whole panel on a bubbled Escape, but with the menu
  // open the first Escape must only dismiss the menu.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', closeMenu, { capture: true, once: true });
    window.addEventListener('resize', closeMenu, { once: true });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', closeMenu, { capture: true });
      window.removeEventListener('resize', closeMenu);
    };
  }, [open, closeMenu]);

  // Estimated menu height for computePopoverPosition: one ~30px row per
  // type plus padding, capped at half the viewport like the child popover
  // so the helper flips above the trigger when needed.
  const estH = typeof window === 'undefined'
    ? 120
    : Math.min(8 + TASK_TYPES.length * 30, window.innerHeight * 0.5);
  const menuPos = open && anchorRect && typeof window !== 'undefined'
    ? computePopoverPosition(anchorRect, estH, window.innerHeight, window.innerWidth)
    : null;

  const menu = open ? (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="Task type"
      data-role="type-picker-menu"
      style={{
        position: 'fixed',
        top: menuPos ? menuPos.top : undefined,
        left: menuPos ? menuPos.left : undefined,
        width: menuPos ? menuPos.width : undefined,
        background: 'var(--t-card)',
        border: '1px solid var(--t-border-strong)',
        borderRadius: 8,
        padding: '4px 0',
        zIndex: 1000,
        minWidth: 140,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}
    >
      {TASK_TYPES.map((t) => (
        <button
          key={t.value}
          type="button"
          role="option"
          aria-selected={t.value === value}
          title={t.tooltip}
          onClick={() => { onChange(t.value as TaskType); setOpen(false); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 12px',
            border: 'none',
            background: t.value === value ? 'var(--t-hover)' : 'transparent',
            color: t.value === value ? 'var(--t-text)' : 'var(--t-text-faint)',
            fontSize: 12,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>{t.icon}</span>
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div
      id={id}
      ref={rootRef}
      style={
        bare
          ? { position: 'relative', display: 'flex', alignItems: 'stretch', flexShrink: 0, alignSelf: 'stretch' }
          : { position: 'relative', display: 'inline-block' }
      }
    >
      <button
        ref={buttonRef}
        type="button"
        title={current?.tooltip}
        aria-label={`Task type: ${current?.label}. Activate to change the task type.`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); if (!disabled) { if (open) closeMenu(); else openMenu(); } }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        style={bare ? {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '4px 10px 4px 8px',
          border: 'none',
          borderRight: '1px solid var(--t-border-faint)',
          borderRadius: 0,
          background: hover && !disabled ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-muted)',
          fontSize: 12,
          fontWeight: 600,
          cursor: disabled ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        } : {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 8px',
          borderRadius: 6,
          border: '1px solid var(--t-border)',
          background: 'var(--t-hover)',
          color: 'var(--t-text-muted)',
          fontSize: 12,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ fontSize: 13 }}>{current?.icon}</span>
        <span>{current?.label}</span>
      </button>

      {/* Portalled out of the trigger wrapper (c94cde70): the detail
          panel's title field owns `overflow: hidden` for its single shared
          border/radius, which clipped this menu into invisibility when it
          rendered inside. In document.body it is never clipped; fixed
          positioning comes from computePopoverPosition — the same helper
          the child popover and badge tooltip already use. */}
      {menu && typeof document !== 'undefined' ? ReactDOM.createPortal(menu, document.body) : null}
    </div>
  );
}
