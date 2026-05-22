import React from 'react';
import { createPortal } from 'react-dom';
import { AutoExpandTextarea } from './AutoExpandTextarea';
import { MarkdownPreview } from './MarkdownPreview';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Value to display in preview mode. Defaults to `value` when omitted. */
  previewValue?: string;
  showPreview: boolean;
  setShowPreview: (v: boolean) => void;
  previewId: string;
  textareaId: string;
  placeholder: string;
  previewEmptyText?: string;
  previewMinHeight?: number;
  previewMaxHeight?: number;
  baseRows?: number;
  maxRows?: number;
  autoFocus?: boolean;
  textareaRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  afterTextarea?: React.ReactNode;
  onBlur?: () => void;
}

export function MarkdownEditableField({
  value,
  onChange,
  previewValue,
  showPreview,
  setShowPreview,
  previewId,
  textareaId,
  placeholder,
  previewEmptyText,
  previewMinHeight = 54,
  previewMaxHeight = 220,
  baseRows = 5,
  maxRows = 12,
  autoFocus = false,
  textareaRef,
  onKeyDown,
  afterTextarea,
  onBlur: onBlurProp,
}: Props) {
  const localTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [taskIndex, setTaskIndex] = React.useState<Array<{ id: string; title: string }>>([]);
  const [taskRefSuggest, setTaskRefSuggest] = React.useState<{
    queryStart: number;
    queryEnd: number;
    items: Array<{ id: string; title: string }>;
  } | null>(null);
  const [dropdownAnchor, setDropdownAnchor] = React.useState<{ top: number; left: number; width: number } | null>(null);

  React.useEffect(() => {
    let active = true;
    fetch('/api/tasks')
      .then((r) => r.json() as Promise<{ tasks?: Array<{ id?: string; title?: string }> }>)
      .then((data) => {
        if (!active) return;
        // Index all tasks (full 30-char hex IDs) for # mention autocomplete.
        const next = (data.tasks ?? [])
          .map((t) => ({ id: String(t.id ?? ''), title: String(t.title ?? '') }))
          .filter((t) => t.id.length > 0);
        setTaskIndex(next);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  function updateTaskRefSuggest(nextValue: string) {
    const el = localTextareaRef.current;
    if (!el) {
      setTaskRefSuggest(null);
      return;
    }

    const cursor = el.selectionStart ?? nextValue.length;
    const before = nextValue.slice(0, cursor);

    // Find the last '#' that is at a word boundary (start of text or preceded by whitespace).
    // The query is everything after that '#', allowing spaces so multi-word titles are searchable.
    let hashPos = -1;
    for (let i = before.length - 1; i >= 0; i--) {
      if (before[i] !== '#') continue;
      const prev = i > 0 ? before[i - 1] : '';
      if (prev && !/\s/.test(prev)) continue;   // '#' must be at a word boundary
      const rawQuery = before.slice(i + 1);
      if (rawQuery.includes('#')) continue;       // inner '#' starts a new ref — skip
      if (rawQuery.length > 80) return;           // too long to be a task ref
      hashPos = i;
      break;
    }

    if (hashPos === -1) {
      setTaskRefSuggest(null);
      return;
    }

    const query = before.slice(hashPos + 1).trim().toLowerCase();
    const items = taskIndex
      .filter((t) => {
        if (!query) return true;
        const id = t.id.toLowerCase();
        const title = t.title.toLowerCase();
        return id.includes(query) || title.includes(query);
      })
      .sort((a, b) => {
        const aIdStarts = a.id.toLowerCase().startsWith(query) ? 1 : 0;
        const bIdStarts = b.id.toLowerCase().startsWith(query) ? 1 : 0;
        if (aIdStarts !== bIdStarts) return bIdStarts - aIdStarts;
        const aTitleStarts = a.title.toLowerCase().startsWith(query) ? 1 : 0;
        const bTitleStarts = b.title.toLowerCase().startsWith(query) ? 1 : 0;
        if (aTitleStarts !== bTitleStarts) return bTitleStarts - aTitleStarts;
        return a.id.localeCompare(b.id);
      })
      .slice(0, 6);

    if (!items.length) {
      setTaskRefSuggest(null);
      setDropdownAnchor(null);
      return;
    }

    // Capture textarea bounding rect for portal positioning (escapes overflow clipping).
    const rect = el.getBoundingClientRect();
    setDropdownAnchor({ top: rect.top, left: rect.left, width: rect.width });

    setTaskRefSuggest({
      queryStart: hashPos,
      queryEnd: cursor,
      items,
    });
  }

  function applyTaskRef(id: string) {
    const suggest = taskRefSuggest;
    if (!suggest) return;
    const nextValue = `${value.slice(0, suggest.queryStart)}#${id} ${value.slice(suggest.queryEnd)}`;
    onChange(nextValue);
    setTaskRefSuggest(null);
    setDropdownAnchor(null);
    requestAnimationFrame(() => {
      const el = localTextareaRef.current;
      if (!el) return;
      const pos = suggest.queryStart + id.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  return showPreview ? (
    <div
      id={previewId}
      onClick={(e) => {
        // Allow link clicks to navigate without also switching to edit mode.
        if ((e.target as HTMLElement).closest('a')) return;
        setShowPreview(false);
      }}
      title="Click to edit"
      style={{
        cursor: 'text',
        minHeight: previewMinHeight,
        background: 'var(--p-input)',
        border: '1px solid var(--p-border-s)',
        borderRadius: 8,
        padding: 10,
        fontSize: 12,
        color: 'var(--p-text-sub)',
        lineHeight: 1.7,
        overflow: 'auto',
        maxHeight: previewMaxHeight,
      }}
    >
      {(previewValue ?? value).trim()
        ? <MarkdownPreview markdown={previewValue ?? value} />
        : <span style={{ color: 'var(--p-border-t)' }}>{previewEmptyText ?? placeholder}</span>}
    </div>
  ) : (
    <div style={{ position: 'relative' }}>
      <AutoExpandTextarea
        id={textareaId}
        ref={(el) => {
          localTextareaRef.current = el;
          if (!textareaRef) return;
          textareaRef.current = el;
        }}
        className="dp-textarea"
        placeholder={placeholder}
        value={value}
        onChange={(next) => {
          onChange(next);
          updateTaskRefSuggest(next);
        }}
        onFocus={() => setShowPreview(false)}
        onBlur={() => {
          setTaskRefSuggest(null);
          setDropdownAnchor(null);
          setShowPreview(true);
          onBlurProp?.();
        }}
        baseRows={baseRows}
        maxRows={maxRows}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setTaskRefSuggest(null); setDropdownAnchor(null); }
          onKeyDown?.(e);
        }}
      />
      {taskRefSuggest && dropdownAnchor && createPortal(
        <div
          data-task-ref-suggest="true"
          style={{
            position: 'fixed',
            left: dropdownAnchor.left + 8,
            width: dropdownAnchor.width - 16,
            top: dropdownAnchor.top,
            transform: 'translateY(-100%)',
            border: '1px solid var(--p-border-s)',
            background: 'var(--p-card)',
            borderRadius: 8,
            boxShadow: 'var(--p-shadow-lg)',
            overflow: 'hidden',
            zIndex: 9999,
          }}
        >
          {taskRefSuggest.items.map((item) => (
            <button
              key={item.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                applyTaskRef(item.id);
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                textAlign: 'left',
                border: 'none',
                borderBottom: '1px solid var(--p-border)',
                background: 'transparent',
                color: 'var(--p-text-sub)',
                padding: '7px 10px',
                fontSize: 11,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--p-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ fontFamily: 'monospace', color: 'var(--p-blue-300)' }}>#{item.id}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
      {afterTextarea}
    </div>
  );
}
