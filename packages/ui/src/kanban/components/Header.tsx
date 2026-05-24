import React from 'react';
import { Search, Settings, X, ChevronRight, Bot, CheckSquare } from 'lucide-react';
import { VibeflowIcon } from '../../VibeflowIcon';
import { HeaderActionButton } from './shared/HeaderActionButton';
import { getTagColors } from '../tag-colors';
import type { AgentRun } from '../types';

interface Props {
  projectName: string;
  projectIcon?: string;
  missingProjectIconStyle?: 'initial' | 'vibeflow';
  wsConnected: boolean;
  port: number;
  searchQuery: string;
  filterTags?: string[];
  allTags?: string[];
  onToggleTag?: (tag: string) => void;
  premiumUsage?: string;
  isLoading?: boolean;
  backHref?: string;
  backLabel?: string;
  onSearchChange: (q: string) => void;
  onSettings: () => void;
  extraActions?: React.ReactNode;
  taskSummary: string;
  /** Active agent runs — shown as a compact status chip in the header. */
  agentRuns?: AgentRun[];
  /** Whether multi-select mode is currently active. */
  selectMode?: boolean;
  /** Toggle multi-select mode on/off. */
  onToggleSelectMode?: () => void;
  /** Number of active (running + queued) agent runs. */
  agentQueueCount?: number;
  /** Open the agent queue side panel. */
  onOpenAgentQueue?: () => void;
  /** When false, agent-related UI is hidden. */
  experimentalAgents?: boolean;
}

export function Header({
  projectName, projectIcon, missingProjectIconStyle = 'initial', wsConnected, port, searchQuery, premiumUsage, isLoading,
  filterTags, allTags, onToggleTag,
  backHref, backLabel,
  onSearchChange, onSettings, extraActions, taskSummary,
  agentRuns,
  selectMode,
  onToggleSelectMode,
  agentQueueCount,
  onOpenAgentQueue,
  experimentalAgents,
}: Props) {
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [dropdownIdx, setDropdownIdx] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  // Detect `#query` at end of search string to show tag picker dropdown
  const hashMatch = searchQuery.match(/(?:^|\s)#(\S*)$/);
  const hashQuery = hashMatch ? hashMatch[1] : null;

  const activeFilterTags = filterTags ?? [];
  const availableTags = (allTags ?? []).filter(t => !activeFilterTags.includes(t));
  const dropdownTags = hashQuery !== null
    ? availableTags.filter(t => t.toLowerCase().includes(hashQuery.toLowerCase()))
    : [];

  // Reset keyboard index when dropdown list changes
  React.useEffect(() => { setDropdownIdx(0); }, [dropdownTags.length]);

  function selectTag(tag: string) {
    // Strip the trailing `#query` fragment (and any preceding space) from the text input
    const cleaned = searchQuery.replace(/\s*#\S*$/, '');
    onSearchChange(cleaned);
    onToggleTag?.(tag);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Backspace with empty input removes the last active filter tag
    if (e.key === 'Backspace' && searchQuery === '' && activeFilterTags.length > 0) {
      e.preventDefault();
      onToggleTag?.(activeFilterTags[activeFilterTags.length - 1]);
      return;
    }
    if (hashQuery === null || dropdownTags.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setDropdownIdx(i => Math.min(i + 1, dropdownTags.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setDropdownIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (dropdownTags[dropdownIdx]) selectTag(dropdownTags[dropdownIdx]);
    } else if (e.key === 'Escape') {
      const cleaned = searchQuery.replace(/\s*#\S*$/, '');
      onSearchChange(cleaned);
    }
  }

  const normalizedProjectIcon = (projectIcon ?? '').trim();
  const displayProjectName = projectName
    ? projectName.charAt(0).toUpperCase() + projectName.slice(1)
    : 'Vibeflow Board';

  const hasContent = searchQuery || activeFilterTags.length > 0;

  return (
    <header className="px-5 py-3 flex items-center gap-3 border-b border-slate-800/60 flex-shrink-0">
      {/* Project identity */}
      <div className="flex items-center gap-3 flex-shrink-0">
        {backHref && (
          <>
            <a
              id="header-back-link"
              href={backHref}
              className="text-xs text-slate-400 hover:text-slate-200 transition-colors no-underline"
              style={{ textDecoration: 'none', fontWeight: 500 }}
            >
              {backLabel ?? 'Back'}
            </a>
            <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />
          </>
        )}
        <div className="flex-shrink-0" style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', ...(normalizedProjectIcon ? { fontSize: 20 } : undefined) }}>
          {normalizedProjectIcon ? normalizedProjectIcon : (
            missingProjectIconStyle === 'vibeflow' ? (
              <VibeflowIcon size={32} />
            ) : (
              <div
                style={{
                  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                  background: 'linear-gradient(135deg, #1e3a5f 0%, #1e293b 100%)',
                  border: '1px solid rgba(37,99,235,0.3)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 700, color: '#93c5fd', letterSpacing: '-0.01em',
                }}
                title={displayProjectName}
              >
                {displayProjectName.charAt(0).toUpperCase()}
              </div>
            )
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 id="header-project-name" className="text-sm font-semibold text-white leading-tight">
              {displayProjectName}
            </h1>
            {wsConnected && (
              <div
                id="header-live-pill"
                className="flex items-center gap-1.5 rounded-full px-2 py-0.5"
                style={{ background: 'color-mix(in srgb, var(--p-green) 30%, transparent)', border: '1px solid color-mix(in srgb, var(--p-green) 28%, transparent)' }}
              >
                <div
                  className="w-1.5 h-1.5 rounded-full bg-green-400"
                  style={{ animation: 'pulse-live 2s ease-in-out infinite' }}
                />
                <span className="text-[10px] font-medium text-green-400">live · :{port}</span>
              </div>
            )}
          </div>
          <p className="text-[10px] text-slate-500 font-mono mt-0.5">
            {taskSummary}
            {isLoading && (
              <span
                id="header-loading-indicator"
                className="inline-block ml-1.5 w-1 h-1 rounded-full bg-blue-400"
                style={{ animation: 'pulse-live 1.4s ease-in-out infinite', verticalAlign: 'middle' }}
              />
            )}
          </p>
        </div>
      </div>

      {/* Token search + # tag picker */}
      <div className="flex-1 flex justify-center px-4">
        <div className="relative w-full max-w-sm">
          {/* Token input container */}
          <div
            className="flex flex-wrap items-center gap-1 w-full min-h-[30px] rounded-lg bg-slate-800 border border-slate-700/60 px-2 py-1 cursor-text transition-colors focus-within:border-blue-500"
            onClick={() => inputRef.current?.focus()}
          >
            <Search className="w-3.5 h-3.5 text-slate-500 flex-shrink-0 mr-0.5" />

            {/* Active tag chips */}
            {activeFilterTags.map(tag => {
              const { bg, text, border } = getTagColors(tag);
              return (
                <span
                  key={tag}
                  style={{ background: bg, color: text, border: `1px solid ${border}`, display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 7px', borderRadius: 100, fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap' }}
                >
                  {tag}
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggleTag?.(tag); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: 'inherit', opacity: 0.7, display: 'flex' }}
                  >
                    <X style={{ width: 9, height: 9 }} />
                  </button>
                </span>
              );
            })}

            {/* Text input */}
            <input
              ref={inputRef}
              id="global-search"
              type="text"
              placeholder={activeFilterTags.length === 0 ? 'Search… or type #tag' : '#tag or search…'}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 min-w-[100px] bg-transparent border-none outline-none text-xs text-slate-200 placeholder-slate-500"
              autoComplete="off"
              spellCheck={false}
            />

            {/* Clear button */}
            {hasContent && (
              <button
                id="global-search-clear"
                onClick={() => { onSearchChange(''); activeFilterTags.forEach(t => onToggleTag?.(t)); }}
                className="text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0 flex"
                title="Clear search and tag filters"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* # tag dropdown */}
          {hashQuery !== null && dropdownTags.length > 0 && (
            <div
              ref={dropdownRef}
              style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--p-card)', border: '1px solid var(--p-border-s)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.3)', zIndex: 50, overflow: 'hidden' }}
            >
              <div style={{ padding: '5px 10px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--p-text-g)', borderBottom: '1px solid var(--p-border)' }}>
                Tags
              </div>
              {dropdownTags.map((tag, i) => {
                const { bg, text, border } = getTagColors(tag);
                return (
                  <button
                    key={tag}
                    onMouseDown={(e) => { e.preventDefault(); selectTag(tag); }}
                    onMouseEnter={() => setDropdownIdx(i)}
                    style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', background: i === dropdownIdx ? 'var(--p-hover)' : 'none', border: 'none', cursor: 'pointer' }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: text, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: 'var(--p-text-m)' }}>{tag}</span>
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: 100, fontSize: 10, background: bg, color: text, border: `1px solid ${border}` }}>
                      tag
                    </span>
                  </button>
                );
              })}
              <div style={{ padding: '5px 10px', fontSize: 10, color: 'var(--p-text-g)', borderTop: '1px solid var(--p-border)' }}>
                ↑↓ navigate · Enter select · Esc close
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {extraActions}

        {experimentalAgents === true && agentRuns && agentRuns.length > 0 && (
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 600,
              border: '1px solid color-mix(in srgb, var(--p-blue) 40%, transparent)',
              background: 'color-mix(in srgb, var(--p-blue) 10%, transparent)',
              color: 'var(--p-blue-300)', flexShrink: 0,
            }}
            title={`${agentRuns.filter(r => r.status === 'running').length} running · ${agentRuns.filter(r => r.status === 'queued').length} queued`}
          >
            <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} />
            {agentRuns.filter(r => r.status === 'running').length} running
            {agentRuns.filter(r => r.status === 'queued').length > 0 && (
              <> · {agentRuns.filter(r => r.status === 'queued').length} queued</>
            )}
          </span>
        )}

        {experimentalAgents === true && onOpenAgentQueue && agentQueueCount !== undefined && agentQueueCount > 0 && (
          <HeaderActionButton
            id="btn-agent-queue"
            title="Agent Queue"
            onClick={onOpenAgentQueue}
            label={`🤖 Queue ${agentQueueCount}`}
            icon={<Bot className="w-3.5 h-3.5" />}
          />
        )}

        {onToggleSelectMode && (
          <HeaderActionButton
            id="btn-select-tasks"
            title={selectMode ? 'Exit selection mode' : 'Select multiple tasks'}
            onClick={onToggleSelectMode}
            label={selectMode ? '✕ Done' : '☑ Select'}
            icon={<CheckSquare className="w-3.5 h-3.5" />}
          />
        )}

        <HeaderActionButton
          id="header-shortcuts-hint"
          title="Click to see keyboard shortcuts"
          onClick={() => setShortcutsOpen(true)}
          label="? shortcuts"
        />

        <HeaderActionButton
          id="btn-settings"
          title="Settings"
          onClick={onSettings}
          icon={<Settings className="w-3.5 h-3.5" />}
        />
      </div>

      {/* Keyboard Shortcuts modal */}
      {shortcutsOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(2,12,27,0.80)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            id="shortcuts-modal"
            style={{ background: 'var(--p-card)', border: '1px solid var(--p-border-s)', borderRadius: 14, padding: '20px 24px', minWidth: 320, maxWidth: 420, boxShadow: 'var(--p-shadow-lg)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--p-text)' }}>Keyboard Shortcuts</span>
              <button onClick={() => setShortcutsOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--p-text-f)', padding: 2 }}><X style={{ width: 14, height: 14 }} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                ['Alt+N', 'Open new task panel'],
                ['Esc', 'Close panel / modal'],
                ['?', 'Show this shortcuts overlay'],
                ['Alt+F', 'Focus task search'],
              ].map(([key, desc]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <kbd style={{ fontSize: 10, fontFamily: 'monospace', background: 'var(--p-surface)', border: '1px solid var(--p-border-t)', borderRadius: 4, padding: '2px 7px', color: 'var(--p-text-sub)', flexShrink: 0 }}>{key}</kbd>
                  <span style={{ fontSize: 12, color: 'var(--p-text-m)' }}>{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
