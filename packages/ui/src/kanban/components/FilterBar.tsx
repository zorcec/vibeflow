import React from 'react';
import { LayoutDashboard, List, Tag, ChevronDown, X, User } from 'lucide-react';
import type { Task, TaskStatus, TaskType } from '../types';
import { getTagColors } from '../tag-colors';

const STATUS_FILTERS: { id: TaskStatus | 'all'; label: string; dot: string }[] = [
  { id: 'all',         label: 'All',        dot: '' },
  { id: 'todo',        label: 'Todo',       dot: 'var(--p-amber)' },
  { id: 'in-progress', label: 'In Progress',dot: 'var(--p-blue)' },
  { id: 'review',      label: 'Review',     dot: 'var(--p-purple)' },
];

const STATUS_ACTIVE_STYLE: Partial<Record<TaskStatus | 'all', React.CSSProperties>> = {
  'todo':        { background: 'color-mix(in srgb, var(--p-amber) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--p-amber) 38%, transparent)', color: 'var(--p-amber-300)' },
  'in-progress': { background: 'color-mix(in srgb, var(--p-blue) 16%, transparent)',  border: '1px solid color-mix(in srgb, var(--p-blue) 38%, transparent)',  color: 'var(--p-blue-200)' },
  'review':      { background: 'color-mix(in srgb, var(--p-purple) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--p-purple) 38%, transparent)', color: 'var(--p-purple-300)' },
  'done':        { background: 'color-mix(in srgb, var(--p-green) 14%, transparent)',  border: '1px solid color-mix(in srgb, var(--p-green) 32%, transparent)',   color: 'var(--p-green-300)' },
  'backlog':     { background: 'color-mix(in srgb, var(--p-text-g) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--p-text-g) 32%, transparent)',  color: 'var(--p-text-m)' },
  'all':         { background: 'color-mix(in srgb, var(--p-blue) 12%, transparent)',   border: '1px solid color-mix(in srgb, var(--p-blue) 32%, transparent)',   color: 'var(--p-blue-200)' },
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
  view?: 'board' | 'list';
  onViewChange?: (view: 'board' | 'list') => void;
  activityCounter?: React.ReactNode;
}

export function FilterBar({ tasks, filter, onFilter, view = 'board', onViewChange, activityCounter }: Props) {
  const [typeOpen, setTypeOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);
  const [tagOpen, setTagOpen] = React.useState(false);

  const types = React.useMemo(() =>
    [...new Set(tasks.map(t => t.type).filter(Boolean) as string[])].sort() as TaskType[],
    [tasks],
  );

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
    background: 'transparent', color: 'var(--p-text-f)', transition: 'all .12s', fontFamily: 'inherit',
    fontWeight: 500,
  };

  const dropBtn: React.CSSProperties = {
    ...pill, background: 'var(--p-card)', border: '1px solid var(--p-border)', color: 'var(--p-text-f)',
    padding: '3px 10px', position: 'relative',
  };

  return (
    <div
      data-proto-id="filter-bar"
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px',
        background: 'var(--p-surface)', borderBottom: '1px solid var(--p-border)', flexShrink: 0,
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
              onMouseOver={e => { if (!isActive) { e.currentTarget.style.background = 'var(--p-hover)'; e.currentTarget.style.color = 'var(--p-text-m)'; } }}
              onMouseOut={e => { if (!isActive) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--p-text-f)'; } }}
              onClick={handleStatusClick}
            >
              {sf.dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: sf.dot, flexShrink: 0, display: 'inline-block' }} />}
              {sf.label}
              {count != null && (
                <span style={{ color: isActive ? 'inherit' : 'var(--p-border-t)', fontSize: 10, opacity: 0.8 }}>{count}</span>
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
        <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:100, background:'color-mix(in srgb, var(--p-purple) 10%, transparent)', border:'1px solid color-mix(in srgb, var(--p-purple) 24%, transparent)', fontSize:10, color:'var(--p-purple-300)' }}>
          {filter.user}
          <button onClick={() => setUser(null)} style={{ display:'flex', background:'none', border:'none', color:'var(--p-purple-300)', cursor:'pointer', padding:0, lineHeight:1 }}><X style={{ width:10, height:10 }} /></button>
        </span>
      )}
      {filter.type && (
        <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:100, background:'color-mix(in srgb, var(--p-blue) 10%, transparent)', border:'1px solid color-mix(in srgb, var(--p-blue) 24%, transparent)', fontSize:10, color:'var(--p-cyan-300)' }}>
          {filter.type}
          <button onClick={() => setType(null)} style={{ display:'flex', background:'none', border:'none', color:'var(--p-cyan-300)', cursor:'pointer', padding:0, lineHeight:1 }}><X style={{ width:10, height:10 }} /></button>
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
          style={{ ...dropBtn, color: (filter.tags ?? []).length ? 'var(--p-green-300)' : 'var(--p-text-f)', borderColor: (filter.tags ?? []).length ? 'color-mix(in srgb, var(--p-green) 36%, transparent)' : 'var(--p-border)', opacity: allTagsInBoard.length ? 1 : 0.55 }}
          onClick={(e) => {
            e.stopPropagation();
            if (!allTagsInBoard.length) return;
            setUserOpen(false); setTypeOpen(false);
            setTagOpen(o => !o);
          }}
        >
          <Tag style={{ width: 12, height: 12 }} />
          Tags
          {(filter.tags ?? []).length > 0 && <span style={{ fontSize: 9, background: 'color-mix(in srgb, var(--p-green) 20%, transparent)', color: 'var(--p-green-300)', borderRadius: 100, padding: '0 4px' }}>{(filter.tags ?? []).length}</span>}
          <ChevronDown style={{ width: 12, height: 12 }} />
        </button>
        {tagOpen && allTagsInBoard.length > 0 && (
          <div
            style={{ position:'absolute', top:'calc(100% + 4px)', right:0, minWidth:160, background:'var(--p-card)', border:'1px solid var(--p-border-s)', borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.25)', zIndex:50, overflow:'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            {(filter.tags ?? []).length > 0 && (
              <button
                style={{ width:'100%', textAlign:'left', padding:'7px 12px', fontSize:11, color:'var(--p-text-f)', background:'none', border:'none', cursor:'pointer', borderBottom:'1px solid var(--p-border)' }}
                onClick={() => onFilter({ ...filter, tags: [] })}
              >Clear tag filters</button>
            )}
            {allTagsInBoard.map(tag => {
              const { bg, text, border } = getTagColors(tag);
              const isActive = (filter.tags ?? []).includes(tag);
              return (
                <button
                  key={tag}
                  style={{ width:'100%', textAlign:'left', padding:'6px 12px', fontSize:11, color:'var(--p-text-m)', background: isActive ? 'var(--p-hover)' : 'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:6 }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--p-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = isActive ? 'var(--p-hover)' : 'none'; }}
                  onClick={() => toggleTag(tag)}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: text, border: `1px solid ${border}`, flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{tag}</span>
                  {isActive && <span style={{ color: text, fontSize: 12, lineHeight: 1 }}>✓</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* User filter */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...dropBtn, color: filter.user ? 'var(--p-purple-300)' : 'var(--p-text-f)', borderColor: filter.user ? 'color-mix(in srgb, var(--p-purple) 36%, transparent)' : 'var(--p-border)', opacity: authors.length ? 1 : 0.55 }}
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
            style={{ position:'absolute', top:'calc(100% + 4px)', right:0, minWidth:160, background:'var(--p-card)', border:'1px solid var(--p-border-s)', borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.25)', zIndex:50, overflow:'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              style={{ width:'100%', textAlign:'left', padding:'7px 12px', fontSize:11, color:'var(--p-text-f)', background:'none', border:'none', cursor:'pointer', borderBottom:'1px solid var(--p-border)' }}
              onClick={() => setUser(null)}
            >All users</button>
            {authors.map(u => (
              <button
                key={u}
                style={{ width:'100%', textAlign:'left', padding:'7px 12px', fontSize:11, color: filter.user === u ? 'var(--p-purple-300)' : 'var(--p-text-m)', background: filter.user === u ? 'color-mix(in srgb, var(--p-purple) 12%, transparent)' : 'none', border:'none', cursor:'pointer' }}
                onMouseOver={e => { if (filter.user !== u) e.currentTarget.style.background = 'var(--p-hover)'; }}
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
            style={{ ...dropBtn, color: filter.type ? 'var(--p-cyan-300)' : 'var(--p-text-f)', borderColor: filter.type ? 'color-mix(in srgb, var(--p-blue) 36%, transparent)' : 'var(--p-border)', opacity: types.length ? 1 : 0.55 }}
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
              style={{ position:'absolute', top:'calc(100% + 4px)', right:0, minWidth:140, background:'var(--p-card)', border:'1px solid var(--p-border-s)', borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.25)', zIndex:50, overflow:'hidden' }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                style={{ width:'100%', textAlign:'left', padding:'7px 12px', fontSize:11, color:'var(--p-text-f)', background:'none', border:'none', cursor:'pointer', borderBottom:'1px solid var(--p-border)' }}
                onClick={() => setType(null)}
              >All types</button>
              {types.map(t => (
                <button
                  key={t}
                  style={{ width:'100%', textAlign:'left', padding:'7px 12px', fontSize:11, color: filter.type === t ? 'var(--p-cyan-300)' : 'var(--p-text-m)', background: filter.type === t ? 'color-mix(in srgb, var(--p-blue) 12%, transparent)' : 'none', border:'none', cursor:'pointer' }}
                  onMouseOver={e => { if (filter.type !== t) e.currentTarget.style.background = 'var(--p-hover)'; }}
                  onMouseOut={e => { if (filter.type !== t) e.currentTarget.style.background = 'none'; }}
                  onClick={() => setType(t)}
                >{t}</button>
              ))}
            </div>
          )}
      </div>

      {/* View toggle */}
      <div style={{ display:'flex', alignItems:'center', background:'var(--p-card)', border:'1px solid var(--p-border)', borderRadius:8, padding:2, gap:0 }}>
        <button
          title="Board view"
          style={{ padding:'4px 7px', borderRadius:5, background: view === 'board' ? 'var(--p-surface)' : 'none', color: view === 'board' ? 'var(--p-text-sub)' : 'var(--p-text-g)', border:'none', cursor:'pointer', display:'flex', alignItems:'center', transition:'background .12s,color .12s' }}
          onClick={(e) => { e.stopPropagation(); onViewChange?.('board'); }}
        >
          <LayoutDashboard style={{ width:13, height:13 }} />
        </button>
        <button
          title="List view"
          style={{ padding:'4px 7px', borderRadius:5, background: view === 'list' ? 'var(--p-surface)' : 'none', color: view === 'list' ? 'var(--p-text-sub)' : 'var(--p-text-g)', border:'none', cursor:'pointer', display:'flex', alignItems:'center', transition:'background .12s,color .12s' }}
          onClick={(e) => { e.stopPropagation(); onViewChange?.('list'); }}
        >
          <List style={{ width:13, height:13 }} />
        </button>
      </div>
    </div>
  );
}
