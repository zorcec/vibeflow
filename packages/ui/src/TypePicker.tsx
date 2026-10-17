import React from 'react';
import { TASK_TYPES } from './task-types';
import type { TaskType } from './task-types';

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
  const current = TASK_TYPES.find((t) => t.value === value) ?? TASK_TYPES[0];

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

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
        type="button"
        title={current?.tooltip}
        aria-label={`Task type: ${current?.label}. Activate to change the task type.`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); if (!disabled) setOpen((o) => !o); }}
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

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            background: 'var(--t-card)',
            border: '1px solid var(--t-border-strong)',
            borderRadius: 8,
            padding: '4px 0',
            zIndex: 200,
            minWidth: 140,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {TASK_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
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
      )}
    </div>
  );
}
