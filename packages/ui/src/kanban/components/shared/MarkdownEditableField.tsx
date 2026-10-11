import React from 'react';
import { createPortal } from 'react-dom';
import { AutoExpandTextarea } from './AutoExpandTextarea';
import { MarkdownPreview } from './MarkdownPreview';
import type { DescriptionSelection } from '../../types';

interface CaretMark {
  key: string;
  name: string;
  color: string;
  top: number;
  left: number;
  height: number;
}

function sameMarks(a: CaretMark[], b: CaretMark[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (m, i) =>
      m.key === b[i]!.key &&
      m.top === b[i]!.top &&
      m.left === b[i]!.left &&
      m.height === b[i]!.height,
  );
}

/**
 * Remote cursors/selections over the description textarea (description only).
 *
 * Each peer gets a mirror div sharing the textarea's own `dp-textarea` class,
 * so wrapping matches by construction — no font-metric replication. Mirror
 * text is transparent; only the selection tint shows. Caret positions are
 * measured from zero-size markers and rendered as absolute flags in a
 * clipped overlay (pointer-events none, so the textarea stays interactive).
 */
function RemoteCursorOverlay({
  text,
  selections,
  textarea,
}: {
  text: string;
  selections: DescriptionSelection[];
  textarea: HTMLTextAreaElement;
}) {
  const markerRefs = React.useRef(new Map<string, HTMLElement | null>());
  const [marks, setMarks] = React.useState<CaretMark[]>([]);
  // Re-render (only) when the textarea scrolls or resizes: wrapping can
  // shift, and scrolled-out carets must move with the text.
  const [, setScrollTick] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setScrollTick((t) => t + 1);
    textarea.addEventListener('scroll', bump, { passive: true });
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(bump)
        : null;
    ro?.observe(textarea);
    return () => {
      textarea.removeEventListener('scroll', bump);
      ro?.disconnect();
    };
  }, [textarea]);

  // Defensive clamp: a cursor recorded against an older (longer) text must
  // never split a mirror out of range.
  const clamped = React.useMemo(
    () =>
      selections.map((s) => ({
        ...s,
        anchor: Math.max(0, Math.min(text.length, Math.floor(s.anchor))),
        head: Math.max(0, Math.min(text.length, Math.floor(s.head))),
      })),
    [selections, text],
  );

  // Measure after the mirrors lay out. Equality-guarded: mirrors don't move
  // on unrelated re-renders, and an unguarded setState here would loop.
  React.useLayoutEffect(() => {
    const cs = window.getComputedStyle(textarea);
    const lineHeight =
      Number.parseFloat(cs.lineHeight || '0') ||
      Number.parseFloat(cs.fontSize || '12') * 1.6;
    const next: CaretMark[] = [];
    for (const sel of clamped) {
      const el = markerRefs.current.get(sel.key);
      if (!el) continue;
      next.push({
        key: sel.key,
        name: sel.name,
        color: sel.color,
        top: el.offsetTop,
        left: el.offsetLeft,
        height: lineHeight,
      });
    }
    setMarks((prev) => (sameMarks(prev, next) ? prev : next));
  }, [textarea, clamped]);

  const scrollTop = textarea.scrollTop;
  const scrollLeft = textarea.scrollLeft;

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      {clamped.map((sel) => {
        const lo = Math.min(sel.anchor, sel.head);
        const hi = Math.max(sel.anchor, sel.head);
        return (
          <div
            key={`mirror-${sel.key}`}
            className="dp-textarea"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              margin: 0,
              background: 'transparent',
              borderColor: 'transparent',
              boxShadow: 'none',
              color: 'transparent',
              caretColor: 'transparent',
              pointerEvents: 'none',
              overflow: 'hidden',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'break-word',
            }}
          >
            <span>{text.slice(0, lo)}</span>
            {hi > lo && (
              <span style={{ backgroundColor: sel.color, opacity: 0.3 }}>
                {text.slice(lo, hi)}
              </span>
            )}
            <span>
              <i
                ref={(el) => {
                  markerRefs.current.set(sel.key, el);
                }}
                style={{ display: 'inline-block', width: 0, height: 0 }}
              />
              {text.slice(hi)}
            </span>
          </div>
        );
      })}
      {marks.map((m) => {
        const top = m.top - scrollTop;
        const left = m.left - scrollLeft;
        const flagBelow = top < 18;
        return (
          <div
            key={`caret-${m.key}`}
            data-remote-cursor={m.key}
            title={m.name}
            style={{
              position: 'absolute',
              top,
              left,
              width: 2,
              height: m.height,
              backgroundColor: m.color,
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: -2,
                ...(flagBelow
                  ? { top: m.height + 2 }
                  : { bottom: '100%', marginBottom: 2 }),
                padding: '0 4px',
                borderRadius: 3,
                backgroundColor: m.color,
                color: '#fff',
                fontSize: 9,
                lineHeight: '14px',
                whiteSpace: 'nowrap',
              }}
            >
              {m.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}

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
  /** Preview min expressed in text rows (mirrors the edit field's row range).
   *  Takes precedence over `previewMinHeight` when provided. */
  previewMinRows?: number;
  /** Preview max expressed in text rows. Takes precedence over `previewMaxHeight`. */
  previewMaxRows?: number;
  baseRows?: number;
  maxRows?: number;
  autoFocus?: boolean;
  textareaRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  afterTextarea?: React.ReactNode;
  onBlur?: () => void;
  /**
   * Remote peers' cursors/selections in the shared description doc.
   * Rendered as an overlay over the textarea — description only, never in
   * comments or other fields. Omit (or pass empty) for a plain editor.
   */
  remoteSelections?: DescriptionSelection[];
  /** Local caret/selection movement, for the throttled cursor broadcast. */
  onSelectionChange?: (anchor: number, head: number) => void;
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
  previewMinRows,
  previewMaxRows,
  baseRows = 5,
  maxRows = 12,
  autoFocus = false,
  textareaRef,
  onKeyDown,
  afterTextarea,
  onBlur: onBlurProp,
  remoteSelections,
  onSelectionChange,
}: Props) {
  const localTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  // Element state (not just a ref) so the cursor overlay re-renders once
  // the textarea mounts and re-measures on scroll/resize.
  const [textareaEl, setTextareaEl] = React.useState<HTMLTextAreaElement | null>(null);

  const reportSelection = React.useCallback(() => {
    if (!onSelectionChange) return;
    const el = localTextareaRef.current;
    if (!el) return;
    onSelectionChange(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  }, [onSelectionChange]);
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

  // Preview box typography — MUST stay in sync with the inline styles on the
  // preview div below (fontSize 12, lineHeight 1.7, padding 10, border 1px):
  // one row is fontSize × lineHeight px, plus 2× padding + 2× border of chrome.
  const PREVIEW_ROW_PX = 12 * 1.7;          // 20.4
  const PREVIEW_CHROME_PX = 10 * 2 + 1 * 2; // 22
  // Rounded to 1dp so the inline style serializes exactly (e.g. `266.8px`,
  // not `266.79999999999995px`).
  const previewRowsToPx = (rows: number): number =>
    Math.round((rows * PREVIEW_ROW_PX + PREVIEW_CHROME_PX) * 10) / 10;

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
        minHeight: previewMinRows !== undefined ? previewRowsToPx(previewMinRows) : previewMinHeight,
        background: 'var(--t-input)',
        border: '1px solid var(--t-border-strong)',
        borderRadius: 8,
        padding: 10,
        fontSize: 12,
        color: 'var(--t-text-sub)',
        lineHeight: 1.7,
        overflow: 'auto',
        maxHeight: previewMaxRows !== undefined ? previewRowsToPx(previewMaxRows) : previewMaxHeight,
      }}
    >
      {(previewValue ?? value).trim()
        ? <MarkdownPreview markdown={previewValue ?? value} />
        : <span style={{ color: 'var(--t-text-faint)' }}>{previewEmptyText ?? placeholder}</span>}
    </div>
  ) : (
    <div style={{ position: 'relative' }}>
      <AutoExpandTextarea
        id={textareaId}
        ref={(el) => {
          localTextareaRef.current = el;
          setTextareaEl((prev) => (prev === el ? prev : el));
          if (!textareaRef) return;
          textareaRef.current = el;
        }}
        className="dp-textarea"
        placeholder={placeholder}
        value={value}
        onChange={(next) => {
          onChange(next);
          updateTaskRefSuggest(next);
          reportSelection();
        }}
        onSelect={reportSelection}
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
            border: '1px solid var(--t-border-strong)',
            background: 'var(--t-card)',
            borderRadius: 8,
            boxShadow: 'var(--t-shadow-lg)',
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
                borderBottom: '1px solid var(--t-border)',
                background: 'transparent',
                color: 'var(--t-text-sub)',
                padding: '7px 10px',
                fontSize: 11,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ fontFamily: 'monospace', color: 'var(--t-accent-soft)' }}>#{item.id}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
      {remoteSelections && remoteSelections.length > 0 && textareaEl && (
        <RemoteCursorOverlay
          text={value}
          selections={remoteSelections}
          textarea={textareaEl}
        />
      )}
      {afterTextarea}
    </div>
  );
}
