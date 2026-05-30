import React from 'react';
import { TypePicker } from '../shared/components/TypePicker.js';
import { AutoExpandTextarea } from '../shared/components/AutoExpandTextarea.js';
import { MarkdownPreview } from '../shared/components/MarkdownPreview.js';
import type { TaskType } from '../shared/task-types.js';
import { getRecordedLogs } from '../overlay-browser/error-recorder.js';
import { state } from '../overlay-browser/state.js';
import { clampTriggerPos } from './trigger-pos.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AddModalOpts {
  initialTitle?: string;
  initialDescription?: string;
  selector?: string;
  cssSelector?: string;
  file?: string;
  line?: number;
  col?: number;
  component?: string;
  initialScreenshot?: string;
}

// ── Bridge: lets vanilla-TS code push state into React ───────────────────────

let _externalShowAddModal: ((opts: AddModalOpts) => void) | null = null;
let _externalFlashTrigger: (() => void) | null = null;
let _externalSetTriggerVisible: (() => void) | null = null;
let _externalHideTrigger: (() => void) | null = null;
let _externalDisableOverlay: (() => void) | null = null;

/** Opens the React add-task modal from vanilla-TS code */
export function showOverlayAddModal(opts: AddModalOpts = {}): void {
  _externalShowAddModal?.(opts);
}

/** Shows the corner trigger after it was hidden — called from the page context menu */
export function showOverlayTrigger(): void {
  _externalSetTriggerVisible?.();
}

/** Hides the corner trigger — called from the page context menu */
export function hideOverlayTrigger(): void {
  _externalHideTrigger?.();
}

/** Disables the entire overlay for this page session (resets on page refresh) */
export function disableVibeflowOverlay(): void {
  _externalDisableOverlay?.();
}

/** Key used to persist badge hidden state across page reloads */
export const TRIGGER_HIDDEN_KEY = 'vibeflow-trigger-hidden';

// ── Prototyping integration ──────────────────────────────────────────────────

interface PrototypingApi {
  openPanel: () => void;
  closePanel: () => void;
}

/** Checks if @vibeflow-tools/ui-prototyping is installed and registered */
function hasPrototypingApi(): boolean {
  return typeof window !== 'undefined' && '__vf_prototyping' in window;
}

/** Opens the variant switcher panel via the prototyping package API */
function openPrototypingPanel(): void {
  const api = (window as any).__vf_prototyping as PrototypingApi | undefined;
  api?.openPanel();
}

/** Briefly animates the page favicon with the Vibeflow Sequential Wave animation when a task is saved. */
function flashFavicon(durationMs: number = 2200): void {
  const head = document.head;
  const existing = head.querySelector<HTMLLinkElement>('link[rel*="icon"]');
  const originalHref = existing?.href ?? '';

  // Remove existing icon link so the new element gets a fresh SVG animation timeline.
  // Reusing the same element and changing .href prevents SMIL animations from running.
  if (existing) existing.remove();

  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';

  const animatedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none"><rect width="18" height="18" rx="4" fill="#2563eb"/><rect x="2.5" y="5" width="2" height="8" rx="1" fill="white" opacity=".7"><animate attributeName="height" values="3;13;3" dur="0.8s" repeatCount="3" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1" begin="0s"/><animate attributeName="y" values="7.5;2.5;7.5" dur="0.8s" repeatCount="3" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1" begin="0s"/></rect><rect x="6.5" y="2" width="2" height="14" rx="1" fill="white"><animate attributeName="height" values="3;15;3" dur="0.8s" repeatCount="3" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1" begin="0.15s"/><animate attributeName="y" values="7.5;1.5;7.5" dur="0.8s" repeatCount="3" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1" begin="0.15s"/></rect><rect x="10.5" y="6" width="2" height="6" rx="1" fill="white" opacity=".7"><animate attributeName="height" values="3;12;3" dur="0.8s" repeatCount="3" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1" begin="0.3s"/><animate attributeName="y" values="7.5;3;7.5" dur="0.8s" repeatCount="3" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1" begin="0.3s"/></rect><rect x="14.5" y="4" width="2" height="10" rx="1" fill="white" opacity=".85"><animate attributeName="height" values="3;13;3" dur="0.8s" repeatCount="3" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1" begin="0.45s"/><animate attributeName="y" values="7.5;2.5;7.5" dur="0.8s" repeatCount="3" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1" begin="0.45s"/></rect></svg>`;

  link.href = `data:image/svg+xml,${encodeURIComponent(animatedSvg)}`;
  head.appendChild(link);

  window.setTimeout(() => {
    link.remove();
    if (originalHref) {
      const restore = document.createElement('link');
      restore.rel = 'icon';
      restore.type = 'image/svg+xml';
      restore.href = originalHref;
      head.appendChild(restore);
    }
  }, durationMs);
}

export function flashOverlayTrigger(): void {
  _externalFlashTrigger?.();
}

// ── Stub exports kept for compatibility with overlay-browser modules ──────────
// These were removed from the main app but other modules still import them.
// The sidebar is gone; these are harmless no-ops that prevent import errors.
export function toggleOverlaySidebar(): void { /* sidebar removed */ }
export function closeOverlaySidebar(): void { /* sidebar removed */ }
export function setOverlayTriggerAnnotating(_active: boolean): void { /* no visual update needed */ }

// ── Corner trigger button (product icon — draggable, opens Kanban board) ──────

function CornerTrigger({
  onClick,
  flashing,
  onHide,
  onDisable,
}: {
  onClick: () => void;
  flashing: boolean;
  onHide: () => void;
  onDisable: () => void;
}) {
  // Equalizer wave icon matching the Vibeflow product icon
  const svgIcon = (
    <svg width="20" height="20" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="5" width="2" height="8" rx="1" fill="currentColor" opacity="0.7"/>
      <rect x="6.5" y="2" width="2" height="14" rx="1" fill="currentColor"/>
      <rect x="10.5" y="6" width="2" height="6" rx="1" fill="currentColor" opacity="0.7"/>
      <rect x="14.5" y="4" width="2" height="10" rx="1" fill="currentColor" opacity="0.85"/>
    </svg>
  );

  // Draggable position state (null = default bottom-right via CSS)
  // Restored from localStorage if previously saved, clamped to current viewport bounds
  // to ensure the button is always visible even if the saved position is out of bounds
  // (e.g. the user was on a larger monitor when they last dragged the button).
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(() => {
    try {
      const saved = localStorage.getItem('vibeflow-trigger-pos');
      if (saved) {
        const parsed = JSON.parse(saved) as { x: number; y: number };
        if (typeof parsed.x === 'number' && isFinite(parsed.x) &&
            typeof parsed.y === 'number' && isFinite(parsed.y)) {
          return clampTriggerPos(parsed, { width: window.innerWidth, height: window.innerHeight });
        }
      }
    } catch { /* ignore */ }
    return null;
  });
  const [isDragging, setIsDragging] = React.useState(false);
  const [isHolding, setIsHolding] = React.useState(false);
  const dragOrigin = React.useRef<{ mouseX: number; mouseY: number; posX: number; posY: number } | null>(null);
  const holdTimer = React.useRef<number | null>(null);
  const didDrag = React.useRef(false);
  const isRightClick = React.useRef(false);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  // Track pos in a ref so the hold-timer callback always has the latest value.
  const posRef = React.useRef<{ x: number; y: number } | null>(null);
  posRef.current = pos;

  // Context menu state (right-click to hide overlay)
  const [ctxMenu, setCtxMenu] = React.useState<{ x: number; y: number } | null>(null);

  // Persist position to localStorage whenever it changes
  React.useEffect(() => {
    if (pos) {
      try { localStorage.setItem('vibeflow-trigger-pos', JSON.stringify(pos)); } catch { /* ignore */ }
    }
  }, [pos]);

  // Close context menu on outside click
  React.useEffect(() => {
    if (!ctxMenu) return;
    function onDocClick() { setCtxMenu(null); }
    document.addEventListener('click', onDocClick, { once: true });
    return () => document.removeEventListener('click', onDocClick);
  }, [ctxMenu]);

  function getInitialPos(el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  }

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    // Capture values immediately — React clears currentTarget after the handler returns.
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    const clientX = e.clientX;
    const clientY = e.clientY;
    didDrag.current = false;
    isRightClick.current = e.button === 2;
    // Right-click: don't start the hold timer at all — let contextmenu handle it.
    if (isRightClick.current) return;
    // Start a hold timer — after 300ms, unlock dragging
    holdTimer.current = window.setTimeout(() => {
      setIsHolding(true);
      const startPos = posRef.current ?? getInitialPos(target);
      dragOrigin.current = { mouseX: clientX, mouseY: clientY, posX: startPos.x, posY: startPos.y };
      target.setPointerCapture(pointerId);
    }, 300);
  }

  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragOrigin.current) return;
    const dx = e.clientX - dragOrigin.current.mouseX;
    const dy = e.clientY - dragOrigin.current.mouseY;
    if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) setIsDragging(true);
    didDrag.current = true;
    const bw = window.innerWidth, bh = window.innerHeight;
    const x = Math.max(8, Math.min(bw - 64, dragOrigin.current.posX + dx));
    const y = Math.max(8, Math.min(bh - 64, dragOrigin.current.posY + dy));
    setPos({ x, y });
  }

  function onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    if (holdTimer.current !== null) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
    const wasDragged = didDrag.current;
    const wasRight = isRightClick.current;
    dragOrigin.current = null;
    setIsDragging(false);
    setIsHolding(false);
    didDrag.current = false;
    isRightClick.current = false;
    if (!wasDragged && !wasRight) onClick();
  }

  function onPointerCancel() {
    if (holdTimer.current !== null) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
    dragOrigin.current = null;
    setIsDragging(false);
    setIsHolding(false);
    didDrag.current = false;
  }

  const posStyle: React.CSSProperties = pos !== null ? {
    position: 'fixed',
    left: pos.x,
    top: pos.y,
    bottom: 'auto',
    right: 'auto',
  } : {};

  const className = [
    'vibeflow-corner-trigger',
    flashing ? 'saved-flash' : '',
    isHolding ? 'trigger-holding' : '',
    isDragging ? 'trigger-dragging' : '',
  ].filter(Boolean).join(' ');

  const title = isDragging ? 'Drag to reposition' : isHolding ? 'Drag to reposition · Release to open' : 'Open Kanban board · Hold to drag';

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Clamp position so menu never gets cut off the screen (with 8px padding).
    // Height varies: 28px base + 28px per menu item (Hide + Disable always, Prototyping if installed)
    const MENU_W = 120, ITEM_H = 28, PAD = 8;
    const itemCount = 2 + (hasPrototypingApi() ? 1 : 0);
    const MENU_H = ITEM_H * itemCount;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - PAD);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - PAD);
    setCtxMenu({ x: Math.max(PAD, x), y: Math.max(PAD, y) });
  }

  return (
    <>
      <button
        ref={buttonRef}
        className={className}
        title={title}
        style={posStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={onContextMenu}
        data-vibeflow-ignore="true"
      >
        {svgIcon}
      </button>
      {ctxMenu && (
        <div
          className="vibeflow-trigger-ctx-menu"
          style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Prototyping variant switcher — only shown if @vibeflow-tools/ui-prototyping is installed */}
          {hasPrototypingApi() && (
            <button
              type="button"
              onClick={() => { setCtxMenu(null); openPrototypingPanel(); }}
            >
              Prototyping
            </button>
          )}
          <button
            type="button"
            onClick={() => { setCtxMenu(null); onHide(); }}
          >
            Hide Vibeflow
          </button>
          <button
            type="button"
            onClick={() => { setCtxMenu(null); onDisable(); }}
          >
            Disable Vibeflow
          </button>
        </div>
      )}
    </>
  );
}

// ── Overlay Add Task Modal (kanban-style) ─────────────────────────────────────
// Replaces the vanilla-DOM showAddTaskModal with a React component that matches
// the kanban DetailPanel look and feel.

const STATUS_OPTIONS = ['backlog', 'todo', 'in-progress', 'review', 'done'] as const;
type StatusOption = (typeof STATUS_OPTIONS)[number];

const STATUS_ACTIVE: Record<StatusOption, React.CSSProperties> = {
  backlog:       { background: 'rgba(100,116,139,0.2)', borderColor: 'rgba(100,116,139,0.5)', color: '#94a3b8' },
  todo:          { background: 'rgba(245,158,11,0.15)',  borderColor: 'rgba(245,158,11,0.4)',  color: '#fcd34d' },
  'in-progress': { background: 'rgba(59,130,246,0.15)', borderColor: 'rgba(59,130,246,0.4)',  color: '#93c5fd' },
  review:        { background: 'rgba(139,92,246,0.15)', borderColor: 'rgba(139,92,246,0.4)',  color: '#c4b5fd' },
  done:          { background: 'rgba(52,211,153,0.12)', borderColor: 'rgba(52,211,153,0.4)',  color: '#6ee7b7' },
};

interface AddModalProps {
  opts: AddModalOpts;
  onClose: () => void;
  onSubmit: (
    selector: string,
    cssSelector: string,
    title: string,
    description: string,
    status: string,
    type: string,
    meta: { file?: string; line?: number; col?: number; component?: string },
  ) => void;
}

function OverlayAddModal({ opts, onClose, onSubmit }: AddModalProps) {
  const [title, setTitle] = React.useState(opts.initialTitle ?? '');
  const [description, setDescription] = React.useState(opts.initialDescription ?? '');
  const [status, setStatus] = React.useState<StatusOption>('todo');
  const [type, setType] = React.useState<TaskType>('Task');
  const [showPreview, setShowPreview] = React.useState(false);
  const [titleError, setTitleError] = React.useState(false);
  const titleRef = React.useRef<HTMLInputElement>(null);

  // ── Draggable modal state ──────────────────────────────────────────────────
  const [dragPos, setDragPos] = React.useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const dragOrigin = React.useRef<{ mouseX: number; mouseY: number; posX: number; posY: number } | null>(null);

  function onHeaderPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Only drag on the header itself, not on interactive children
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = dragPos?.x ?? (window.innerWidth / 2 - 270);
    const startY = dragPos?.y ?? (window.innerHeight / 2 - 200);
    dragOrigin.current = { mouseX: e.clientX, mouseY: e.clientY, posX: startX, posY: startY };
    setIsDragging(true);
  }

  function onHeaderPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragOrigin.current) return;
    const dx = e.clientX - dragOrigin.current.mouseX;
    const dy = e.clientY - dragOrigin.current.mouseY;
    setDragPos({ x: dragOrigin.current.posX + dx, y: dragOrigin.current.posY + dy });
  }

  function onHeaderPointerUp() {
    dragOrigin.current = null;
    setIsDragging(false);
  }

  React.useEffect(() => { setTimeout(() => titleRef.current?.focus(), 50); }, []);

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleSave();
  }

  function handleSave() {
    const t = title.trim();
    if (!t) {
      setTitleError(true);
      titleRef.current?.focus();
      return;
    }
    setTitleError(false);
    let desc = description.trim() || t;
    if (type === 'Bug') {
      const logs = getRecordedLogs();
      if (logs) desc += logs;
    }
    onSubmit(
      opts.selector ?? location.pathname,
      opts.cssSelector ?? location.pathname,
      t,
      desc,
      status,
      type,
      { file: opts.file, line: opts.line, col: opts.col, component: opts.component },
    );
    onClose();
  }

  const statusBtnBase: React.CSSProperties = {
    padding: '2px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
    border: '1px solid var(--vibeflow-border-strong)', background: 'transparent', color: 'var(--vibeflow-text-muted)',
    fontFamily: 'inherit', fontWeight: 500, transition: 'all .12s',
  };

  const modalStyle: React.CSSProperties = dragPos !== null ? {
    position: 'fixed',
    left: dragPos.x,
    top: dragPos.y,
    margin: 0,
  } : {};

  const headerStyle: React.CSSProperties = {
    cursor: isDragging ? 'grabbing' : 'grab',
    userSelect: 'none',
  };

  // Drag handle icon (6-dot grip)
  const DragHandle = (
    <span
      title="Drag to move"
      style={{ display: 'flex', alignItems: 'center', color: 'var(--vibeflow-text-muted)', opacity: 0.5, flexShrink: 0, pointerEvents: 'none' }}
    >
      <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">
        <circle cx="3" cy="3" r="1.5"/>
        <circle cx="9" cy="3" r="1.5"/>
        <circle cx="3" cy="8" r="1.5"/>
        <circle cx="9" cy="8" r="1.5"/>
        <circle cx="3" cy="13" r="1.5"/>
        <circle cx="9" cy="13" r="1.5"/>
      </svg>
    </span>
  );

  return (
    <div className="vibeflow-modal-backdrop" onClick={handleBackdropClick} onKeyDown={handleKeyDown}>
      <div className="vibeflow-modal overlay-add-modal" role="dialog" aria-modal="true" style={modalStyle}>

        {/* ── Header: drag handle + TypePicker + title + close ── */}
        <div
          className="modal-header overlay-modal-header"
          style={headerStyle}
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
        >
          {DragHandle}
          <TypePicker value={type} onChange={setType} />

          <input
            ref={titleRef}
            type="text"
            placeholder="Task title…"
            value={title}
            onChange={e => { setTitle(e.target.value); if (titleError && e.target.value.trim()) setTitleError(false); }}
            style={{ flex: 1, fontSize: 14, fontWeight: 600, padding: '4px 8px', border: `1px solid ${titleError ? 'rgba(239,68,68,0.7)' : 'transparent'}`, borderRadius: 6, background: titleError ? 'rgba(239,68,68,0.07)' : 'transparent', color: 'var(--vibeflow-text-primary)', fontFamily: 'inherit', outline: 'none', cursor: 'text' }}
            onFocus={e => { if (!titleError) { e.currentTarget.style.borderColor = 'var(--vibeflow-accent-strong)'; e.currentTarget.style.background = 'var(--vibeflow-surface-elevated)'; } }}
            onBlur={e => { if (!titleError) { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'transparent'; } }}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
          />
          {titleError && (
            <span style={{ fontSize: 11, color: 'rgba(239,68,68,0.9)', flexShrink: 0, whiteSpace: 'nowrap' }}>
              Title is required
            </span>
          )}

          <button
            type="button"
            onClick={onClose}
            style={{ width: 26, height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--vibeflow-text-muted)', cursor: 'pointer' }}
            onMouseOver={e => { e.currentTarget.style.background = 'var(--vibeflow-surface-hover)'; e.currentTarget.style.color = 'var(--vibeflow-text-secondary)'; }}
            onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--vibeflow-text-muted)'; }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* ── Status pills ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderBottom: '1px solid var(--vibeflow-border-strong)' }}>
          <span style={{ fontSize: 10, color: 'var(--vibeflow-text-muted)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Status</span>
          {STATUS_OPTIONS.map(s => (
            <button
              key={s}
              type="button"
              style={{ ...statusBtnBase, ...(s === status ? STATUS_ACTIVE[s] : {}) }}
              onClick={() => setStatus(s)}
              onMouseOver={e => { if (s !== status) { e.currentTarget.style.background = 'var(--vibeflow-surface-hover)'; e.currentTarget.style.color = 'var(--vibeflow-text-secondary)'; } }}
              onMouseOut={e => { if (s !== status) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--vibeflow-text-muted)'; } }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* ── Source info (if available) ── */}
        {(opts.file || opts.component) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', background: 'var(--vibeflow-surface-elevated)', borderBottom: '1px solid var(--vibeflow-border-subtle)', fontSize: 11, color: 'var(--vibeflow-text-muted)' }}>
            {opts.file && (
              <a
                href={`vscode://file${opts.file}${opts.line != null ? `:${opts.line}` : ''}`}
                target="_blank"
                rel="noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 4, background: 'var(--vibeflow-accent-soft)', border: '1px solid var(--vibeflow-accent-border)', color: 'var(--vibeflow-accent-strong)', textDecoration: 'none', fontSize: 11 }}
              >
                🗎 {opts.file.split('/').slice(-2).join('/')}{opts.line != null ? `:${opts.line}` : ''}
              </a>
            )}
            {opts.component && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', borderRadius: 4, background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)', color: '#8b5cf6', fontSize: 11 }}>
                ⬡ {opts.component}
              </span>
            )}
          </div>
        )}

        {/* ── Body: description tabs with shared AutoExpandTextarea + MarkdownPreview ── */}
        <div className="modal-tabs">
          <div className={`modal-tab${!showPreview ? ' active' : ''}`} onClick={() => setShowPreview(false)}>Edit</div>
          <div className={`modal-tab${showPreview ? ' active' : ''}`} onClick={() => setShowPreview(true)}>Preview</div>
        </div>

        <div className="modal-body">
          {!showPreview ? (
            <div className="modal-editor-pane">
              <AutoExpandTextarea
                className="dp-textarea"
                placeholder="Description (markdown supported)…"
                value={description}
                onChange={setDescription}
                baseRows={5}
                maxRows={14}
              />
            </div>
          ) : (
            <MarkdownPreview
              markdown={description}
              className="modal-preview-pane"
            />
          )}

          {/* ── Body: description tabs with shared AutoExpandTextarea + MarkdownPreview ── */}
        </div>

        {/* ── Bug report console notice ── */}
        {type === 'Bug' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 16px', background: 'rgba(239,68,68,0.06)', borderTop: '1px solid rgba(239,68,68,0.18)', fontSize: 11, color: 'rgba(239,68,68,0.75)' }}>
            <span>🔴</span>
            <span>Console errors &amp; warnings will be attached to this report</span>
          </div>
        )}

        {/* ── Footer ── */}
        <div className="modal-footer">
          <div className="modal-footer-left">
            <button type="button" className="btn-primary" onClick={handleSave} disabled={!title.trim()} style={{ opacity: title.trim() ? 1 : 0.45, cursor: title.trim() ? 'pointer' : 'not-allowed' }}>Add Task</button>
            <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          </div>
          <div className="modal-footer-center" />
        </div>
      </div>
    </div>
  );
}

// ── Root overlay app ──────────────────────────────────────────────────────────

interface OverlayAppProps {
  onOpenKanban: () => void;
  onSubmitTask: (
    selector: string,
    cssSelector: string,
    title: string,
    description: string,
    status: string,
    type: string,
    meta: { file?: string; line?: number; col?: number; component?: string },
  ) => void;
}

export function OverlayApp({ onOpenKanban, onSubmitTask }: OverlayAppProps) {
  const [addModalOpts, setAddModalOpts] = React.useState<AddModalOpts | null>(null);
  const [triggerFlashing, setTriggerFlashing] = React.useState(false);
  const [isHidden, setIsHidden] = React.useState(() => {
    try { return localStorage.getItem(TRIGGER_HIDDEN_KEY) === '1'; } catch { return false; }
  });

  // Register external bridge so vanilla-TS code can open the modal
  React.useEffect(() => {
    _externalShowAddModal = (opts) => setAddModalOpts(opts);
    _externalFlashTrigger = () => {
      setTriggerFlashing(true);
      window.setTimeout(() => setTriggerFlashing(false), 1500);
      flashFavicon();
    };
    _externalSetTriggerVisible = () => {
      try { localStorage.removeItem(TRIGGER_HIDDEN_KEY); } catch { /* ignore */ }
      setIsHidden(false);
    };
    _externalHideTrigger = () => {
      try { localStorage.setItem(TRIGGER_HIDDEN_KEY, '1'); } catch { /* ignore */ }
      setIsHidden(true);
    };
    _externalDisableOverlay = () => {
      state.disabled = true;
      if (state.host) { state.host.remove(); state.host = null; }
    };
    return () => {
      _externalShowAddModal = null;
      _externalFlashTrigger = null;
      _externalSetTriggerVisible = null;
      _externalHideTrigger = null;
      _externalDisableOverlay = null;
    };
  }, []);

  // On the CLI Studio kanban page, skip rendering the trigger to avoid
  // overlapping kanban panel controls.
  const isKanbanPage = typeof document !== 'undefined' && document.body.hasAttribute('data-vibeflow-cli-kanban');

  return (
    <>
      {!isKanbanPage && !isHidden && (
        <CornerTrigger
          onClick={onOpenKanban}
          flashing={triggerFlashing}
          onHide={() => {
            try { localStorage.setItem(TRIGGER_HIDDEN_KEY, '1'); } catch { /* ignore */ }
            setIsHidden(true);
          }}
          onDisable={() => {
            state.disabled = true;
            if (state.host) { state.host.remove(); state.host = null; }
          }}
        />
      )}
      {addModalOpts !== null && (
        <OverlayAddModal
          opts={addModalOpts}
          onClose={() => setAddModalOpts(null)}
          onSubmit={(selector, cssSelector, title, description, status, type, meta) => {
            onSubmitTask(selector, cssSelector, title, description, status, type, meta);
            setAddModalOpts(null);
          }}
        />
      )}
    </>
  );
}
