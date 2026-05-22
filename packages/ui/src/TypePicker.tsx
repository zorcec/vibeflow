import React from 'react';
import { TASK_TYPES } from './task-types';
import type { TaskType } from './task-types';

interface Props {
  id?: string;
  value: TaskType | string | null | undefined;
  onChange: (value: TaskType) => void;
  disabled?: boolean;
}

// ── TypePicker ────────────────────────────────────────────────────────────────
// Inline-styled dropdown for choosing task type. Works in both CLI (via CSS class
// passthrough) and SaaS (inline styles). The current type is displayed as an icon
// + label; clicking opens a compact option list.
export function TypePicker({ id, value, onChange, disabled }: Props) {
  const [open, setOpen] = React.useState(false);
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
    <div id={id} ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        title={current?.tooltip}
        onClick={(e) => { e.preventDefault(); if (!disabled) setOpen((o) => !o); }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 8px',
          borderRadius: 6,
          border: '1px solid var(--p-border, rgba(255,255,255,0.08))',
          background: 'var(--p-hover, rgba(255,255,255,0.05))',
          color: 'var(--p-text-m, rgba(255,255,255,0.7))',
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
            background: 'var(--p-card, #1e293b)',
            border: '1px solid var(--p-border-s, rgba(255,255,255,0.12))',
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
                background: t.value === value ? 'var(--p-hover, rgba(255,255,255,0.06))' : 'transparent',
                color: t.value === value ? 'var(--p-text, #fff)' : 'var(--p-text-f, rgba(255,255,255,0.55))',
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
