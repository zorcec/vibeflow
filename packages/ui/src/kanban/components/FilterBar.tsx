import React from 'react';
import { LayoutDashboard, List, Rows3, Tag, ChevronDown, X, User } from 'lucide-react';
import type { Task, TaskStatus, TaskType } from '../types';
import { TASK_TYPE_FILTER_OPTIONS } from '../../task-types';
import { getTagColors } from '../tag-colors';
import { ConfirmModal } from './ConfirmModal';

const STATUS_FILTERS: { id: TaskStatus | 'all'; label: string; dot: string }[] = [
  { id: 'all',         label: 'All',        dot: '' },
  { id: 'todo',        label: 'Todo',       dot: 'var(--t-warning)' },
  { id: 'in-progress', label: 'In Progress',dot: 'var(--t-accent)' },
  { id: 'review',      label: 'Review',     dot: 'var(--t-secondary)' },
];

const STATUS_ACTIVE_STYLE: Partial<Record<TaskStatus | 'all', React.CSSProperties>> = {
  'todo':        { background: 'color-mix(in srgb, var(--t-warning) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--t-warning) 38%, transparent)', color: 'var(--t-chip-amber-300)' },
  'in-progress': { background: 'color-mix(in srgb, var(--t-accent) 16%, transparent)',  border: '1px solid color-mix(in srgb, var(--t-accent) 38%, transparent)',  color: 'var(--t-chip-blue-200)' },
  'review':      { background: 'color-mix(in srgb, var(--t-secondary) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--t-secondary) 38%, transparent)', color: 'var(--t-chip-purple-300)' },
  'done':        { background: 'color-mix(in srgb, var(--t-success) 14%, transparent)',  border: '1px solid color-mix(in srgb, var(--t-success) 32%, transparent)',   color: 'var(--t-chip-green-300)' },
  'backlog':     { background: 'color-mix(in srgb, var(--t-text-body) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--t-text-body) 32%, transparent)',  color: 'var(--t-chip-slate-400)' },
  'all':         { background: 'color-mix(in srgb, var(--t-accent) 12%, transparent)',   border: '1px solid color-mix(in srgb, var(--t-accent) 32%, transparent)',   color: 'var(--t-chip-blue-200)' },
};

export interface FilterState {
  status: TaskStatus | 'all';
  component: string | null;
  type: TaskType | null;
  user: string | null;
  tags: string[];
}

interface Props {
  tasks: Task[];
  filter: FilterState;
  onFilter: (f: FilterState) => void;
  view?: 'board' | 'compact' | 'list';
  onViewChange?: (view: 'board' | 'compact' | 'list') => void;
  activityCounter?: React.ReactNode;
  /** Ticket db2fce26 (UI half only): when present, each tag in the tags
      filter gets a hover/focus-revealed "Remove" action that asks for
      confirmation and then calls this. Resolves with the tasks changed.
      When absent the action is not rendered at all (no dead button). */
  onRemoveTagFromAll?: (tag: string) => Promise<number>;
  /** Override for the confirmation count. Defaults to counting `tasks`
      that carry the tag — prefer the data the filter already has. */
  countTasksWithTag?: (tag: string) => number;
}

export function FilterBar({ tasks, filter, onFilter, view = 'board', onViewChange, activityCounter, onRemoveTagFromAll, countTasksWithTag }: Props) {
  const [typeOpen, setTypeOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);
  const [tagOpen, setTagOpen] = React.useState(false);
  // Ticket db2fce26: per-tag "Remove" action state.
  const [hoverTag, setHoverTag] = React.useState<string | null>(null);
  const [focusTag, setFocusTag] = React.useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = React.useState<{ tag: string; count: number } | null>(null);
  const [removing, setRemoving] = React.useState(false);
  // Synchronous in-flight guard: React state lands on the next render, so
  // two confirms inside the same tick (double click, Enter + click) would
  // both read `removing === false` and fire twice. The ref flips in the
  // same task, making a second invocation impossible by construction.
  const removingRef = React.useRef(false);
  const [removeError, setRemoveError] = React.useState<string | undefined>(undefined);
  // Focus return targets: the Remove button that opened the confirmation.
  const removeBtnRefs = React.useRef(new Map<string, HTMLButtonElement>());

  const defaultCountTasksWithTag = React.useCallback((tag: string) =>
    tasks.filter(t => (t.tags ?? []).includes(tag)).length,
  [tasks]);
  const countFn = countTasksWithTag ?? defaultCountTasksWithTag;

  function openRemoveConfirm(tag: string) {
    setRemoveError(undefined);
    setPendingRemove({ tag, count: countFn(tag) });
  }

  function closeRemoveConfirm() {
    // Ignore close/cancel requests while a removal is pending: Escape or a
    // Cancel reaching here mid-flight would clear `removing` while the
    // promise is still out, letting a reopened confirm fire a second call.
    // The dialog stays open (still showing its spinner) until the first
    // call settles; the ref below is the synchronous source of truth.
    if (removingRef.current) return;
    const tag = pendingRemove?.tag;
    setPendingRemove(null);
    setRemoving(false);
    setRemoveError(undefined);
    // Return focus to the tag that opened the confirmation.
    if (tag) removeBtnRefs.current.get(tag)?.focus();
  }

  async function confirmRemoveTag() {
    if (!pendingRemove || !onRemoveTagFromAll || removingRef.current) return;
    const { tag } = pendingRemove;
    removingRef.current = true;
    setRemoving(true);
    setRemoveError(undefined);
    try {
      await onRemoveTagFromAll(tag);
      removingRef.current = false;
      closeRemoveConfirm();
    } catch (e) {
      removingRef.current = false;
      setRemoving(false);
      setRemoveError(e instanceof Error ? e.message : 'Could not remove the tag.');
    }
  }

  // Ticket zbew735s: the product has exactly three types — the filter offers
  // the canonical three from the ONE exported constant (never data-derived),
  // with a friendly label per type. Tasks stored under a legacy alias
  // (Feature/Enhancement → Task) match via `matchesTaskTypeFilter` at the
  // filtering call sites, so they stay findable instead of being hidden.
  const types = TASK_TYPE_FILTER_OPTIONS;

  const authors = React.useMemo(() =>
    [...new Set(tasks.map(t => t.author).filter(Boolean) as string[])].sort(),
    [tasks],
  );

  const allTagsInBoard = React.useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) for (const tag of t.tags ?? []) set.add(tag);
    return [...set].sort();
  }, [tasks]);

  function countByStatus(s: TaskStatus) {
    return tasks.filter(t => t.status === s).length;
  }

  function setStatus(s: TaskStatus | 'all') {
    onFilter({ ...filter, status: s });
    setTypeOpen(false);
    setUserOpen(false);
    setTagOpen(false);
  }

  function setType(t: TaskType | null) {
    onFilter({ ...filter, type: t });
    setTypeOpen(false);
  }

  function setUser(u: string | null) {
    onFilter({ ...filter, user: u });
    setUserOpen(false);
  }

  function toggleTag(tag: string) {
    const current = filter.tags ?? [];
    const next = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag];
    onFilter({ ...filter, tags: next });
  }

  function handleStatusClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    const status = e.currentTarget.dataset.status as TaskStatus | 'all' | undefined;
    if (!status) return;
    setStatus(status);
  }

  const pill: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px',
    borderRadius: 6, fontSize: 11, cursor: 'pointer', border: '1px solid transparent',
    background: 'transparent', color: 'var(--t-text-body)', transition: 'all .12s', fontFamily: 'inherit',
    fontWeight: 500,
  };

  const dropBtn: React.CSSProperties = {
    ...pill, background: 'var(--t-card)', border: '1px solid var(--t-border)', color: 'var(--t-text-body)',
    padding: '3px 10px', position: 'relative',
  };

  return (
    <div
      data-testid="filter-bar"
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px',
        background: 'var(--t-surface)', borderBottom: '1px solid var(--t-border)', flexShrink: 0,
      }}
      onClick={() => { setTypeOpen(false); setUserOpen(false); setTagOpen(false); }}
    >
      {/* Status filter pills */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {STATUS_FILTERS.map(sf => {
          const isActive = filter.status === sf.id;
          const count = sf.id !== 'all' ? countByStatus(sf.id as TaskStatus) : null;
          const activeStyle = isActive ? STATUS_ACTIVE_STYLE[sf.id] : {};
          return (
            <button
              key={sf.id}
              data-status={sf.id}
              style={{ ...pill, ...activeStyle }}
              onMouseOver={e => { if (!isActive) { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text-muted)'; } }}
              onMouseOut={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-body)'; } }}
              onClick={handleStatusClick}
            >
              {sf.dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: sf.dot, flexShrink: 0, display: 'inline-block' }} />}
              {sf.label}
              {count != null && (
                <span style={{ color: isActive ? 'inherit' : 'var(--t-text-body)', fontSize: 10, opacity: 0.8 }}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1 }} />

      {/* Activity counter slot */}
      {activityCounter}

      {/* Active filter chips */}
      {filter.user && (
        <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:100, background:'color-mix(in srgb, var(--t-secondary) 10%, transparent)', border:'1px solid color-mix(in srgb, var(--t-secondary) 24%, transparent)', fontSize:10, color:'var(--t-chip-purple-300)' }}>
          {filter.user}
          <button onClick={() => setUser(null)} style={{ display:'flex', background:'none', border:'none', color:'var(--t-chip-purple-300)', cursor:'pointer', padding:0, lineHeight:1 }}><X style={{ width:10, height:10 }} /></button>
        </span>
      )}
      {filter.type && (
        <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:100, background:'color-mix(in srgb, var(--t-accent) 10%, transparent)', border:'1px solid color-mix(in srgb, var(--t-accent) 24%, transparent)', fontSize:10, color:'var(--t-cyan-soft)' }}>
          {filter.type}
          <button onClick={() => setType(null)} style={{ display:'flex', background:'none', border:'none', color:'var(--t-cyan-soft)', cursor:'pointer', padding:0, lineHeight:1 }}><X style={{ width:10, height:10 }} /></button>
        </span>
      )}
      {(filter.tags ?? []).map(tag => {
        const { bg, text, border } = getTagColors(tag);
        return (
          <span key={tag} style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:100, background:bg, border:`1px solid ${border}`, fontSize:10, color:text, fontWeight:600 }}>
            {tag}
            <button onClick={() => toggleTag(tag)} style={{ display:'flex', background:'none', border:'none', color:text, cursor:'pointer', padding:0, lineHeight:1 }}><X style={{ width:10, height:10 }} /></button>
          </span>
        );
      })}

      {/* Tags filter */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...dropBtn, color: (filter.tags ?? []).length ? 'var(--t-success-subtle)' : 'var(--t-text-faint)', borderColor: (filter.tags ?? []).length ? 'color-mix(in srgb, var(--t-success) 36%, transparent)' : 'var(--t-border)', opacity: allTagsInBoard.length ? 1 : 0.55 }}
          onClick={(e) => {
            e.stopPropagation();
            if (!allTagsInBoard.length) return;
            setUserOpen(false); setTypeOpen(false);
            setTagOpen(o => !o);
          }}
        >
          <Tag style={{ width: 12, height: 12 }} />
          Tags
          {(filter.tags ?? []).length > 0 && <span style={{ fontSize: 9, background: 'color-mix(in srgb, var(--t-success) 20%, transparent)', color: 'var(--t-success-subtle)', borderRadius: 100, padding: '0 4px' }}>{(filter.tags ?? []).length}</span>}
          <ChevronDown style={{ width: 12, height: 12 }} />
        </button>
        {tagOpen && allTagsInBoard.length > 0 && (
          <div
            style={{ position:'absolute', top:'calc(100% + 4px)', right:0, minWidth:160, background:'var(--t-card)', border:'1px solid var(--t-border-strong)', borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.25)', zIndex:50, overflow:'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            {(filter.tags ?? []).length > 0 && (
              <button
                style={{ width:'100%', textAlign:'left', padding:'7px 12px', fontSize:11, color:'var(--t-text-body)', background:'none', border:'none', cursor:'pointer', borderBottom:'1px solid var(--t-border)' }}
                onClick={() => onFilter({ ...filter, tags: [] })}
              >Clear tag filters</button>
            )}
            {allTagsInBoard.map(tag => {
              const { bg, text, border } = getTagColors(tag);
              const isActive = (filter.tags ?? []).includes(tag);
              // Ticket db2fce26: revealed on hover AND on keyboard focus —
              // never hover-only — so keyboard users can reach Remove by Tab.
              const revealed = hoverTag === tag || focusTag === tag;
              return (
                <div
                  key={tag}
                  data-tag-row={tag}
                  style={{ width:'100%', textAlign:'left', padding:'6px 12px', fontSize:11, color:'var(--t-text-muted)', background: (isActive || revealed) ? 'var(--t-hover)' : 'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}
                  onMouseEnter={() => setHoverTag(tag)}
                  onMouseLeave={() => setHoverTag(cur => cur === tag ? null : cur)}
                  onFocus={() => setFocusTag(tag)}
                  onBlur={() => setFocusTag(cur => cur === tag ? null : cur)}
                >
                  <button
                    aria-pressed={isActive}
                    style={{ flex:1, minWidth:0, textAlign:'left', padding:0, fontSize:11, color:'var(--t-text-muted)', background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6, fontFamily:'inherit' }}
                    onClick={() => toggleTag(tag)}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: text, border: `1px solid ${border}`, flexShrink: 0 }} />
                    <span style={{ flex: 1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{tag}</span>
                    {isActive && <span style={{ color: text, fontSize: 12, lineHeight: 1 }}>✓</span>}
                  </button>
                  {onRemoveTagFromAll && (
                    <button
                      ref={el => { if (el) removeBtnRefs.current.set(tag, el); else removeBtnRefs.current.delete(tag); }}
                      aria-label={`Remove ${tag} from all tasks`}
                      className="tag-remove-btn"
                      style={{ flexShrink:0, fontSize:10, fontWeight:600, color:'var(--t-danger)', background:'none', border:'none', cursor:'pointer', padding:'2px 4px', borderRadius:4, opacity: revealed ? 1 : 0, fontFamily:'inherit' }}
                      onClick={(e) => { e.stopPropagation(); openRemoveConfirm(tag); }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* User filter */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...dropBtn, color: filter.user ? 'var(--t-chip-purple-300)' : 'var(--t-text-faint)', borderColor: filter.user ? 'color-mix(in srgb, var(--t-secondary) 36%, transparent)' : 'var(--t-border)', opacity: authors.length ? 1 : 0.55 }}
          onClick={(e) => {
            e.stopPropagation();
            if (!authors.length) return;
            setTypeOpen(false);
            setUserOpen(o => !o);
          }}
        >
          <User style={{ width: 12, height: 12 }} />
          User
          <ChevronDown style={{ width: 12, height: 12 }} />
        </button>
        {userOpen && authors.length > 0 && (
          <div
            style={{ position:'absolute', top:'calc(100% + 4px)', right:0, minWidth:160, background:'var(--t-card)', border:'1px solid var(--t-border-strong)', borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.25)', zIndex:50, overflow:'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              style={{ width:'100%', textAlign:'left', padding:'7px 12px', fontSize:11, color:'var(--t-text-body)', background:'none', border:'none', cursor:'pointer', borderBottom:'1px solid var(--t-border)' }}
              onClick={() => setUser(null)}
            >All users</button>
            {authors.map(u => (
              <button
                key={u}
                style={{ width:'100%', textAlign:'left', padding:'7px 12px', fontSize:11, color: filter.user === u ? 'var(--t-secondary-soft)' : 'var(--t-text-muted)', background: filter.user === u ? 'color-mix(in srgb, var(--t-secondary) 12%, transparent)' : 'none', border:'none', cursor:'pointer' }}
                onMouseOver={e => { if (filter.user !== u) e.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseOut={e => { if (filter.user !== u) e.currentTarget.style.background = 'none'; }}
                onClick={() => setUser(u)}
              >{u}</button>
            ))}
          </div>
        )}
      </div>

      {/* Type filter */}
      <div style={{ position: 'relative' }}>
          <button
            style={{ ...dropBtn, color: filter.type ? 'var(--t-cyan-soft)' : 'var(--t-text-faint)', borderColor: filter.type ? 'color-mix(in srgb, var(--t-accent) 36%, transparent)' : 'var(--t-border)', opacity: types.length ? 1 : 0.55 }}
            onClick={(e) => {
              e.stopPropagation();
              if (!types.length) return;
              setTypeOpen(o => !o);
            }}
          >
            <Tag style={{ width: 12, height: 12 }} />
            Type
            <ChevronDown style={{ width: 12, height: 12 }} />
          </button>
          {typeOpen && types.length > 0 && (
            <div
              style={{ position:'absolute', top:'calc(100% + 4px)', right:0, minWidth:140, background:'var(--t-card)', border:'1px solid var(--t-border-strong)', borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.25)', zIndex:50, overflow:'hidden' }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                style={{ width:'100%', textAlign:'left', padding:'7px 12px', fontSize:11, color:'var(--t-text-body)', background:'none', border:'none', cursor:'pointer', borderBottom:'1px solid var(--t-border)' }}
                onClick={() => setType(null)}
              >All types</button>
              {types.map(t => (
                <button
                  key={t.value}
                  style={{ width:'100%', textAlign:'left', padding:'7px 12px', fontSize:11, color: filter.type === t.value ? 'var(--t-cyan-soft)' : 'var(--t-text-muted)', background: filter.type === t.value ? 'color-mix(in srgb, var(--t-accent) 12%, transparent)' : 'none', border:'none', cursor:'pointer' }}
                  onMouseOver={e => { if (filter.type !== t.value) e.currentTarget.style.background = 'var(--t-hover)'; }}
                  onMouseOut={e => { if (filter.type !== t.value) e.currentTarget.style.background = 'none'; }}
                  onClick={() => setType(t.value)}
                >{t.label}</button>
              ))}
            </div>
          )}
      </div>

      {/* View toggle */}
      <div style={{ display:'flex', alignItems:'center', background:'var(--t-card)', border:'1px solid var(--t-border)', borderRadius:8, padding:2, gap:0 }}>
        <button
          title="Board view"
          style={{ padding:'4px 7px', borderRadius:5, background: view === 'board' ? 'var(--t-surface)' : 'none', color: view === 'board' ? 'var(--t-text-sub)' : 'var(--t-text-body)', border:'none', cursor:'pointer', display:'flex', alignItems:'center', transition:'background .12s,color .12s' }}
          onClick={(e) => { e.stopPropagation(); onViewChange?.('board'); }}
        >
          <LayoutDashboard style={{ width:13, height:13 }} />
        </button>
        <button
          title="Compact view"
          style={{ padding:'4px 7px', borderRadius:5, background: view === 'compact' ? 'var(--t-surface)' : 'none', color: view === 'compact' ? 'var(--t-text-sub)' : 'var(--t-text-body)', border:'none', cursor:'pointer', display:'flex', alignItems:'center', transition:'background .12s,color .12s' }}
          onClick={(e) => { e.stopPropagation(); onViewChange?.('compact'); }}
        >
          <Rows3 style={{ width:13, height:13 }} />
        </button>
        <button
          title="List view"
          style={{ padding:'4px 7px', borderRadius:5, background: view === 'list' ? 'var(--t-surface)' : 'none', color: view === 'list' ? 'var(--t-text-sub)' : 'var(--t-text-body)', border:'none', cursor:'pointer', display:'flex', alignItems:'center', transition:'background .12s,color .12s' }}
          onClick={(e) => { e.stopPropagation(); onViewChange?.('list'); }}
        >
          <List style={{ width:13, height:13 }} />
        </button>
      </div>
      {/* Ticket db2fce26: per-tag bulk-remove confirmation (UI half only).
          Escape aborts via ModalBase; focus returns to the tag on close. */}
      {pendingRemove && (
        <ConfirmModal
          open
          title={`Remove "${pendingRemove.tag}"?`}
          message={`Remove "${pendingRemove.tag}" from ${pendingRemove.count} task${pendingRemove.count === 1 ? '' : 's'}? This cannot be undone.`}
          confirmLabel="Remove"
          loading={removing}
          error={removeError}
          onConfirm={() => void confirmRemoveTag()}
          onCancel={closeRemoveConfirm}
        />
      )}
    </div>
  );
}
