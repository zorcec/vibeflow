import React from 'react';
import { createPortal } from 'react-dom';
import type { Task, TaskStatus, PanelState, AppSettings, AgentRun, AgentStatus } from '@vibeflow-tools/ui/kanban';
import { KanbanHeader as Header, KanbanBoard, COLUMNS, KanbanListView, DetailPanel, FilterBar, SettingsModal, FilePreviewModal, AgentQueuePanel, computeReorder, compareTaskOrder } from '@vibeflow-tools/ui/kanban';
import type { FilterState } from '@vibeflow-tools/ui/kanban';
import { api } from './api.js';

type ViewMode = 'board' | 'list';

const PORT = (window as unknown as { __PORT__?: number }).__PORT__ ?? 3700;
const SAAS_MODE = (window as unknown as { __SAAS_MODE__?: boolean }).__SAAS_MODE__ ?? false;
const BOARD_URL = (window as unknown as { __BOARD_URL__?: string }).__BOARD_URL__ ?? "";
const BOARD_NAME = (window as unknown as { __BOARD_NAME__?: string }).__BOARD_NAME__ ?? "";
const IS_ADMIN = (window as unknown as { __IS_ADMIN__?: boolean }).__IS_ADMIN__ ?? false;

type PushState = 'idle' | 'pushing' | 'done' | 'error';

function OnlineModeOverlay({ onClose }: { onClose?: () => void }) {
  const BASE = window.location.origin;
  const [pushState, setPushState] = React.useState<PushState>('idle');
  const [keepLocalFiles, setKeepLocalFiles] = React.useState(true);
  const [pushResult, setPushResult] = React.useState<{ imported: number; skipped?: number } | null>(null);
  const [pushError, setPushError] = React.useState('');

  async function handlePush() {
    setPushState('pushing');
    setPushError('');
    try {
      const r = await fetch(`${BASE}/api/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepLocalFiles }),
      });
      const data = await r.json() as { imported?: number; skipped?: number; error?: string };
      if (!r.ok) { setPushError(data.error ?? 'Push failed'); setPushState('error'); return; }
      setPushResult({ imported: data.imported ?? 0, skipped: data.skipped });
      setPushState('done');
    } catch (e) {
      setPushError(e instanceof Error ? e.message : 'Network error');
      setPushState('error');
    }
  }

  const isWorking = pushState === 'pushing';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(5, 8, 18, 0.72)',
      backdropFilter: 'blur(10px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    }}>
      <div style={{
        background: '#101827',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 24,
        maxWidth: 380,
        width: '100%',
        boxShadow: '0 0 0 1px rgba(59,130,246,0.07), 0 40px 80px rgba(0,0,0,0.75)',
        overflow: 'hidden',
        position: 'relative',
      }}>
        {/* Top accent line */}
        <div style={{
          position: 'absolute', top: 0, left: '20%', right: '20%', height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.5), transparent)',
        }} />

        {/* Hero */}
        <div style={{ padding: '36px 36px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
          {/* Brand icon */}
          <div style={{ position: 'relative', width: 52, height: 52, marginBottom: 22 }}>
            <svg width="52" height="52" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="18" height="18" rx="4" fill="#2563eb" />
              <rect x="2.5" y="5" width="2" height="8" rx="1" fill="white" opacity="0.7" />
              <rect x="6.5" y="2" width="2" height="14" rx="1" fill="white" />
              <rect x="10.5" y="6" width="2" height="6" rx="1" fill="white" opacity="0.7" />
              <rect x="14.5" y="4" width="2" height="10" rx="1" fill="white" opacity="0.85" />
            </svg>
          </div>

          <h1 style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.3px', margin: '0 0 7px' }}>
            Online Mode Active
          </h1>
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.36)', lineHeight: 1.5, margin: 0 }}>
            Connected to{' '}
            <strong style={{ color: 'rgba(255,255,255,0.55)', fontWeight: 500 }}>
              {BOARD_NAME || 'Vibeflow SaaS'}
            </strong>
          </p>
        </div>

        {/* Push banner */}
        {pushState === 'done' && pushResult && (
          <div style={{
            margin: '0 28px 0', padding: '10px 14px', borderRadius: 9, fontSize: 12,
            display: 'flex', alignItems: 'center', gap: 9,
            background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.18)', color: '#34d399',
          }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M13 5L6.5 11.5 3 8" stroke="#34d399" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {pushResult.imported} task{pushResult.imported !== 1 ? 's' : ''} pushed to board
            {pushResult.skipped != null && pushResult.skipped > 0 ? ` · ${pushResult.skipped} already existed` : ''}
          </div>
        )}

        {pushState === 'error' && pushError && (
          <div style={{
            margin: '0 28px 0', padding: '10px 14px', borderRadius: 9, fontSize: 12,
            display: 'flex', alignItems: 'center', gap: 9,
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.18)', color: '#f87171',
          }}>
            {pushError}
          </div>
        )}

        {/* Actions */}
        <div style={{ padding: '20px 24px 28px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {BOARD_URL && (
            <a
              href={BOARD_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                padding: 14, background: '#2563eb', border: 'none', borderRadius: 12,
                color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                textDecoration: 'none', letterSpacing: '-0.1px',
                transition: 'background 0.15s, transform 0.1s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#3b82f6'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#2563eb'; e.currentTarget.style.transform = 'none'; }}
            >
              Open Web App →
            </a>
          )}

          {pushState !== 'done' && (
            <button
              onClick={() => void handlePush()}
              disabled={isWorking}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                padding: 12, background: 'transparent',
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12,
                color: isWorking ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.4)',
                fontSize: 13, fontWeight: 500, cursor: isWorking ? 'not-allowed' : 'pointer',
                transition: 'border-color 0.15s, color 0.15s, background 0.15s',
              }}
              onMouseEnter={e => { if (!isWorking) { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'; e.currentTarget.style.color = 'rgba(255,255,255,0.65)'; e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; } }}
              onMouseLeave={e => { if (!isWorking) { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.background = 'transparent'; } }}
            >
              {isWorking ? '⏳ Pushing…' : '↑ Push local tasks'}
            </button>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px 20px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={keepLocalFiles}
              onChange={e => setKeepLocalFiles(e.target.checked)}
              style={{ accentColor: '#2563eb', width: 13, height: 13, cursor: 'pointer' }}
            />
            <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.28)' }}>Keep local files</span>
          </label>
          {IS_ADMIN && onClose && (
            <button
              onClick={onClose}
              style={{
                fontSize: 11, color: 'rgba(255,255,255,0.2)', background: 'none', border: 'none',
                cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2,
                transition: 'color 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.45)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.2)'; }}
            >
              Dismiss (admin)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done',
};

interface StatusEntry {
  taskId: string;
  field: string;
  from: string;
  to: string;
  actor: string;
  timestamp: string;
  source?: 'cli' | 'web';
}

function buildTaskSummary(tasks: Task[], visibleCols: TaskStatus[], search: string): string {
  const filtered = search
    ? tasks.filter(t =>
        t.title?.toLowerCase().includes(search) ||
        t.description?.toLowerCase().includes(search)
      )
    : tasks;
  if (search) return `${filtered.length} of ${tasks.length} tasks`;
  const open = filtered.filter(t => t.status !== 'done').length;
  const wip = filtered.filter(t => t.status === 'in-progress').length;
  const rev = filtered.filter(t => t.status === 'review').length;
  return `${open} open · ${wip} in-progress · ${rev} in review`;
}

export function App() {
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [overlayDismissed, setOverlayDismissed] = React.useState(false);
  const [panelState, setPanelState] = React.useState<PanelState>({
    open: false, task: null, tab: 'details',
  });
  const [viewMode, setViewMode] = React.useState<ViewMode>('board');
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [filePreview, setFilePreview] = React.useState({ open: false, name: '', url: '' });
  const [panelWidth, setPanelWidth] = React.useState(420);
  const [isResizingPanel, setIsResizingPanel] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [visibleCols, setVisibleCols] = React.useState<TaskStatus[]>(COLUMNS.map(c => c.id));
  const [filterState, setFilterState] = React.useState<FilterState>({ status: 'all', component: null, type: null, user: null, tags: [] });
  const [projectName, setProjectName] = React.useState('Proto Board');
  const [wsConnected, setWsConnected] = React.useState(false);
  const [hadWsConnection, setHadWsConnection] = React.useState(false);
  const [gitUserName, setGitUserName] = React.useState('You');
  const [githubUrl, setGithubUrl] = React.useState<string | null>(null);
  const [premiumUsage, setPremiumUsage] = React.useState('');
  const [appSettings, setAppSettings] = React.useState<AppSettings>({});
  const [models, setModels] = React.useState<{ id: string; label: string; provider: string }[]>([]);
  const [agents, setAgents] = React.useState<{ id: string; name: string; scope: string }[]>([]);
  const wsRef = React.useRef<WebSocket | null>(null);
  const wsRetryRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const consumedHashTaskRef = React.useRef<string | null>(null);
  // Navigation history for task-ref jumping (supports browser back + UI back button).
  const [navHistory, setNavHistory] = React.useState<Task[]>([]);
  const suppressHistoryPushRef = React.useRef(false);
  // Keep a ref to latest tasks that WS handlers can read without stale closure.
  const tasksRef = React.useRef<Task[]>([]);
  // In-session log of status changes for the detail panel activity tab.
  const [statusChangeLog, setStatusChangeLog] = React.useState<StatusEntry[]>([]);
  // ── Agent queue state (v1: single agent execution) ───────────────────────
  const [agentRuns, setAgentRuns] = React.useState<AgentRun[]>([]);
  const [selectMode, setSelectMode] = React.useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = React.useState<Set<string>>(new Set());
  const [agentQueueOpen, setAgentQueueOpen] = React.useState(false);

  function runAgent(taskId: string, model: string, agent?: string) {
    const task = tasksRef.current.find((t) => t.id === taskId);
    if (!task) return;
    // Move task to in-progress when agent starts
    if (task.status !== 'in-progress') {
      patchTask(taskId, { status: 'in-progress' });
    }
    // Use task agent, or fall back to default agent from settings
    const effectiveAgent = agent || task.agent || appSettings.defaultAgent || 'build';
    // Call the server to spawn opencode — the server will broadcast events
    // that update the agentRuns state via WebSocket.
    fetch(`${baseUrl}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, model, agent: effectiveAgent }),
    }).then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to start agent' }));
        setAgentRuns((prev) =>
          prev.map((r) =>
            r.taskId === taskId
              ? { ...r, status: 'failed' as AgentStatus, logs: [...r.logs, `✗ ${err.error ?? 'Failed to start agent'}`] }
              : r,
          ),
        );
      }
    }).catch((err) => {
      setAgentRuns((prev) =>
        prev.map((r) =>
          r.taskId === taskId
            ? { ...r, status: 'failed' as AgentStatus, logs: [...r.logs, `✗ Network error: ${err.message}`] }
            : r,
        ),
      );
    });
  }

  function stopAgent(taskId: string) {
    // Call the server to stop the opencode process
    fetch(`${baseUrl}/api/agent/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    }).catch(() => {});

    setAgentRuns((prev) => {
      const wasRunning = prev.some((r) => r.taskId === taskId && r.status === 'running');
      const updated = prev.map((r) =>
        r.taskId === taskId && r.status === 'running'
          ? { ...r, status: 'failed' as AgentStatus, logs: [...r.logs, '✗ Stopped by user'] }
          : r,
      );
      if (wasRunning) {
        const next = updated.find((r) => r.status === 'queued');
        if (next) {
          return updated.map((r) =>
            r.taskId === next.taskId
              ? { ...r, status: 'running' as AgentStatus, startedAt: new Date().toISOString(), logs: [...r.logs, '▶ Starting agent run…'] }
              : r,
          );
        }
      }
      return updated;
    });
  }

  function dequeueAgent(taskId: string) {
    setAgentRuns((prev) => prev.filter((r) => r.taskId !== taskId));
  }

  function toggleSelect(taskId: string) {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  function runSelectedAgents(taskIds: string[]) {
    for (const id of taskIds) {
      runAgent(id, 'claude-sonnet-4-5');
    }
    setSelectMode(false);
    setSelectedTaskIds(new Set());
  }

  // Load initial data
  React.useEffect(() => {
    void loadTasks();
    void loadMeta();
    void loadAppSettings();
    void loadCopilotStatus();
    void loadGithubUrl();
    void loadModels();
    void loadAgents();
    connectWs();
    return () => {
      if (wsRetryRef.current) clearTimeout(wsRetryRef.current);
      wsRef.current?.close();
    };
  }, []);

  // No polling fallback: the board is driven entirely by WS events.

  React.useEffect(() => {
    document.body.setAttribute('data-theme', 'dark');
  }, []);

  // Allow #task-<id> deep-links from markdown references in comments/descriptions.
  // Only full 30-char hex task IDs are supported (short 8-char prefixes removed).
  // Navigation history is maintained for the back button.
  React.useEffect(() => {
    function openTaskFromHash() {
      const m = window.location.hash.match(/^#task-([a-f0-9]{30})$/i);
      if (!m) {
        consumedHashTaskRef.current = null;
        return;
      }
      const refId = m[1].toLowerCase();
      if (consumedHashTaskRef.current === refId) return;
      const task = tasks.find((t) => t.id.toLowerCase() === refId);
      if (!task) return;
      consumedHashTaskRef.current = refId;

      // Push current task to nav history (unless we're going back)
      if (!suppressHistoryPushRef.current) {
        setPanelState((prev) => {
          if (prev.task && prev.task.id !== task.id) {
            setNavHistory((h) => [...h, prev.task!]);
          }
          return { ...prev, open: true, task, tab: 'details' };
        });
      } else {
        setPanelState((prev) => ({ ...prev, open: true, task, tab: 'details' }));
      }
      suppressHistoryPushRef.current = false;
    }

    // Listen for task-ref clicks from MarkdownPreview so we can record history
    // before the hash changes. This prevents the opened task from being added
    // before we know the "from" task.
    function onTaskRefClick() {
      // The vibeflow-task-ref-click event fires synchronously before the hash change.
      // The actual history push happens in openTaskFromHash via setPanelState.
      // No extra action needed here — just let hashchange handle it.
    }

    openTaskFromHash();
    const onHashChange = () => {
      consumedHashTaskRef.current = null;
      openTaskFromHash();
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('vibeflow-task-ref-click', onTaskRefClick);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('vibeflow-task-ref-click', onTaskRefClick);
    };
  }, [tasks]);

  // Keyboard shortcuts
  // Sync open panel task with live task updates (e.g. tag additions, status changes)
  React.useEffect(() => {
    if (!panelState.open || !panelState.task) return;
    const updated = tasks.find(t => t.id === panelState.task!.id);
    if (!updated) return;
    const current = panelState.task;
    const changed = (Object.keys(updated) as (keyof typeof updated)[]).some(k => updated[k] !== current[k]);
    if (changed) setPanelState(prev => ({ ...prev, task: updated }));
  }, [tasks, panelState.open, panelState.task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === 'Escape') {
        if (filePreview.open) { setFilePreview(p => ({ ...p, open: false })); return; }
        if (panelState.open) { setPanelState(p => ({ ...p, open: false })); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
      }
      if (inInput) return;
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        (document.getElementById('header-shortcuts-hint') as HTMLButtonElement | null)?.click();
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        openPanel(null, 'details');
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        const searchInput = document.getElementById('global-search') as HTMLInputElement | null;
        searchInput?.focus();
        searchInput?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filePreview.open, panelState.open, settingsOpen]);

  function appendStatusChange(taskId: string, fromStatus: TaskStatus, toStatus: TaskStatus, actor: string, source?: 'cli' | 'web') {
    const timestamp = new Date().toISOString();
    const from = STATUS_LABELS[fromStatus] ?? fromStatus;
    const to = STATUS_LABELS[toStatus] ?? toStatus;
    const recent = Date.now() - 3000;
    setStatusChangeLog((prev) => {
      const duplicate = prev.some(
        (e) => e.taskId === taskId && e.to === to && new Date(e.timestamp).getTime() > recent,
      );
      if (duplicate) return prev;
      return [...prev, { taskId, field: 'status', from, to, actor, timestamp, source }].slice(-500);
    });
  }

  async function loadTasks() {
    try {
      const data = await api.getTasks();
      tasksRef.current = data.tasks ?? [];
      setTasks(data.tasks ?? []);
    } catch {} finally {
      setIsLoading(false);
    }
  }

  const upsertTaskFromWs = React.useCallback((incoming: Record<string, unknown>, actor?: string, source?: 'cli' | 'web') => {
    const id = String(incoming.id ?? '');
    if (!id) return;
    const incomingCreated = incoming.created ?? incoming.createdAt;
    const updated = incoming.updated ? String(incoming.updated) : undefined;
    const commentCount = Array.isArray(incoming.comments) ? incoming.comments.length : undefined;
    const fileCount = Array.isArray(incoming.files) ? incoming.files.length : undefined;
    const newStatus = incoming.status ? String(incoming.status) as TaskStatus : undefined;

    // Detect status change from remote WS event before updating state
    const prevTask = tasksRef.current.find((t) => t.id === id);
    if (newStatus && prevTask && prevTask.status !== newStatus) {
      appendStatusChange(id, prevTask.status, newStatus, actor ?? 'Someone', source);
    }

    setTasks((prev) => {
      const existing = prev.find((t) => t.id === id);
      const mapped: Task = {
        id,
        title: incoming.title ? String(incoming.title) : (existing?.title ?? 'Untitled'),
        description: incoming.description != null ? String(incoming.description) : (existing?.description ?? ''),
        status: (newStatus ?? existing?.status ?? 'todo') as TaskStatus,
        type: incoming.type ? String(incoming.type) as Task['type'] : existing?.type,
        priority: incoming.priority ? String(incoming.priority) as Task['priority'] : existing?.priority,
        agent: incoming.agent ? String(incoming.agent) : existing?.agent,
        model: incoming.model ? String(incoming.model) : existing?.model,
        selector: incoming.selector ? String(incoming.selector) : existing?.selector,
        cssSelector: incoming.cssSelector ? String(incoming.cssSelector) : existing?.cssSelector,
        file: incoming.file ? String(incoming.file) : existing?.file,
        line: typeof incoming.line === 'number' ? incoming.line : existing?.line,
        col: typeof incoming.col === 'number' ? incoming.col : existing?.col,
        component: incoming.component ? String(incoming.component) : existing?.component,
        url: incoming.url ? String(incoming.url) : existing?.url,
        reportBack: incoming.reportBack === true || existing?.reportBack === true,
        commit: incoming.commit ? String(incoming.commit) : existing?.commit,
        commits: Array.isArray(incoming.commits) ? (incoming.commits as { sha: string; message: string; timestamp: string }[]) : existing?.commits,
        commentCount: commentCount ?? existing?.commentCount,
        fileCount: fileCount ?? existing?.fileCount,
        createdAt: incomingCreated ? String(incomingCreated) : (existing?.createdAt ?? new Date().toISOString()),
        updatedAt: updated ?? existing?.updatedAt,
        author: incoming.author ? String(incoming.author) : existing?.author,
        tags: Array.isArray(incoming.tags) ? (incoming.tags as string[]) : existing?.tags,
        sortKey: incoming.sortKey ? String(incoming.sortKey) : existing?.sortKey,
      };

      const next = prev.filter((t) => t.id !== id);
      next.push(mapped);
      next.sort((a, b) => {
        const aDate = new Date(a.updatedAt ?? a.createdAt ?? '').getTime();
        const bDate = new Date(b.updatedAt ?? b.createdAt ?? '').getTime();
        if (aDate === bDate) return a.id.localeCompare(b.id);
        return bDate - aDate;
      });
      tasksRef.current = next;
      return next;
    });
  // appendStatusChange is stable (useCallback with empty deps); intentional empty dep array
  }, []);

  async function loadMeta() {
    try {
      const data = await api.getProject();
      if (data.name) setProjectName(data.name);
      if (data.gitUserName) setGitUserName(data.gitUserName);
    } catch {}
  }

  async function loadGithubUrl() {
    try {
      const data = await fetch('/api/github-url').then((r) => r.json()) as { githubUrl: string | null };
      setGithubUrl(data.githubUrl ?? null);
    } catch {}
  }

  async function loadAppSettings() {
    try {
      const settingsData = await api.getSettings();
      const settings = settingsData as AppSettings;
      // Default experimentalAgents to true when not explicitly saved (opt-out model)
      if (settings.experimentalAgents === undefined) settings.experimentalAgents = true;
      setAppSettings(settings);
      if (settings.visibleCols?.length) setVisibleCols(settings.visibleCols);
      if (settings.viewMode) setViewMode(settings.viewMode);
      if (settings.panelWidth && settings.panelWidth >= 280 && settings.panelWidth <= 900) {
        setPanelWidth(settings.panelWidth);
      }
    } catch {}
  }

  async function loadCopilotStatus() {
    try {
      const data = await api.getCopilotStatus();
      if (data?.authenticated && data?.username) {
        setPremiumUsage(`Copilot: ${data.username}`);
      } else {
        setPremiumUsage('Copilot: not logged in');
      }
    } catch {}
  }

  async function loadModels() {
    try {
      if (api.getModels) {
        const data = await api.getModels();
        if (data.models && data.models.length > 0) {
          setModels(data.models);
        }
      }
    } catch {}
  }

  async function loadAgents() {
    try {
      if (api.getAgents) {
        const data = await api.getAgents();
        if (data.agents && data.agents.length > 0) {
          setAgents(data.agents);
        }
      }
    } catch {}
  }

  function connectWs() {
    const wsScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsScheme}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.addEventListener('open', () => {
      setWsConnected(true);
      setHadWsConnection(true);
      void loadTasks();
    });
    ws.addEventListener('close', () => {
      setWsConnected(false);
      wsRetryRef.current = setTimeout(connectWs, 1500);
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === 'tasks-updated' || msg.type?.startsWith('task:')) {
          void loadTasks();
          return;
        }
        if (msg.type === 'task-changed' && msg.task) {
          const task = msg.task as Record<string, unknown>;
          const actor = typeof task.alteredBy === 'string' ? task.alteredBy
            : typeof task.author === 'string' ? task.author
            : 'Someone';
          const source = msg.source === 'cli' ? 'cli' as const : undefined;
          upsertTaskFromWs(task, actor, source);
          return;
        }
        if (msg.type === 'task-deleted' && msg.taskId) {
          const taskId = String(msg.taskId);
          setTasks((prev) => { const next = prev.filter((t) => t.id !== taskId); tasksRef.current = next; return next; });
        }
        // Agent run events from server
        if (msg.type === 'agent-run-started') {
          setAgentRuns((prev) => {
            const existing = prev.find((r) => r.taskId === msg.taskId && (r.status === 'running' || r.status === 'queued'));
            if (existing) return prev; // already tracked
            const task = tasksRef.current.find((t) => t.id === msg.taskId);
            const hasRunning = prev.some((r) => r.status === 'running');
            const newRun: AgentRun = {
              taskId: msg.taskId,
              taskTitle: task?.title ?? msg.taskId.slice(0, 8),
              status: hasRunning ? 'queued' : 'running',
              model: msg.model,
              worktree: `wt/task-${msg.taskId.slice(0, 8)}`,
              branch: `agent/task-${msg.taskId.slice(0, 8)}`,
              startedAt: hasRunning ? undefined : new Date().toISOString(),
              logs: [msg.command ?? `▶ Starting agent run…`],
            };
            return [...prev, newRun];
          });
          return;
        }
        if (msg.type === 'agent-run-log') {
          setAgentRuns((prev) =>
            prev.map((r) => {
              if (r.taskId !== msg.taskId) return r;
              const next = { ...r, logs: [...r.logs, msg.log] };
              // Try to parse opencode JSON events inline to accumulate metadata
              // even before the run finishes (handles dropped connections gracefully)
              for (const line of msg.log.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('{')) continue;
                try {
                  const event = JSON.parse(trimmed) as Record<string, unknown>;
                  if (event.type === 'step_finish' && typeof event.part === 'object' && event.part) {
                    const part = event.part as Record<string, unknown>;
                    const tokens = part.tokens as Record<string, number> | undefined;
                    const cost = typeof part.cost === 'number' ? part.cost : 0;
                    if (tokens) {
                      next.inputTokens = (next.inputTokens ?? 0) + (tokens.input ?? 0);
                      next.outputTokens = (next.outputTokens ?? 0) + (tokens.output ?? 0);
                      next.totalTokens = (next.totalTokens ?? 0) + (tokens.total ?? 0);
                      next.reasoningTokens = (next.reasoningTokens ?? 0) + (tokens.reasoning ?? 0);
                      next.cost = (next.cost ?? 0) + cost;
                    }
                  }
                } catch { /* ignore non-JSON lines */ }
              }
              return next;
            }),
          );
          return;
        }
        if (msg.type === 'agent-run-finished') {
          setAgentRuns((prev) => {
            const updated = prev.map((r) =>
              r.taskId === msg.taskId
                ? {
                    ...r,
                    status: (msg.success ? 'done' : 'failed') as AgentStatus,
                    completedAt: new Date().toISOString(),
                    logs: [...r.logs, msg.success ? '✓ Agent run completed' : `✗ Agent run failed (exit ${msg.exitCode})`],
                    inputTokens: typeof msg.inputTokens === 'number' ? msg.inputTokens : r.inputTokens,
                    outputTokens: typeof msg.outputTokens === 'number' ? msg.outputTokens : r.outputTokens,
                    totalTokens: typeof msg.totalTokens === 'number' ? msg.totalTokens : r.totalTokens,
                    reasoningTokens: typeof msg.reasoningTokens === 'number' ? msg.reasoningTokens : r.reasoningTokens,
                    cost: typeof msg.cost === 'number' ? msg.cost : r.cost,
                    durationMs: r.startedAt ? Date.now() - new Date(r.startedAt).getTime() : undefined,
                  }
                : r,
            );
            // Auto-start next queued
            const running = updated.find((r) => r.status === 'running');
            if (!running) {
              const next = updated.find((r) => r.status === 'queued');
              if (next) {
                return updated.map((r) =>
                  r.taskId === next.taskId
                    ? { ...r, status: 'running' as AgentStatus, startedAt: new Date().toISOString(), logs: [...r.logs, '▶ Starting agent run…'] }
                    : r,
                );
              }
            }
            return updated;
          });
          return;
        }
      } catch {}
    });
    // Keep-alive ping
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 20000);
    ws.addEventListener('close', () => clearInterval(pingInterval));
  }

  async function patchTask(id: string, updates: Partial<Task>) {
    const previous = tasksRef.current.find(t => t.id === id);
    setTasks(prev => { const next = prev.map(t => t.id === id ? { ...t, ...updates } : t); tasksRef.current = next; return next; });
    if (updates.status && previous?.status && updates.status !== previous.status) {
      appendStatusChange(id, previous.status, updates.status, gitUserName);
    }
    try {
      const data = await api.updateTask(id, updates);
      if (data.task) setTasks(prev => { const next = prev.map(t => t.id === id ? data.task! : t); tasksRef.current = next; return next; });
    } catch { void loadTasks(); }
  }

  async function handleReorder(taskId: string, newStatus: TaskStatus, beforeId: string | null, afterId: string | null, explicitSortKey?: string) {
    const colTasks = tasksRef.current
      .filter(t => t.status === newStatus)
      .sort(compareTaskOrder);

    const result = computeReorder(colTasks, taskId, beforeId, afterId);
    const newSortKey = explicitSortKey ?? result.newSortKey;
    const normalizationPatches = result.normalizationPatches;

    // Apply optimistic updates for all affected tasks at once
    setTasks(prev => {
      const patches = new Map<string, Partial<Task>>();
      for (const { id, sortKey } of normalizationPatches) patches.set(id, { sortKey });
      patches.set(taskId, { status: newStatus, sortKey: newSortKey });
      const next = prev.map(t => patches.has(t.id) ? { ...t, ...patches.get(t.id) } : t);
      tasksRef.current = next;
      return next;
    });

    // Only persist the dragged task — normalization patches are applied optimistically
    // in the UI but must not trigger server-side updates for other tasks.
    await api.updateTask(taskId, { status: newStatus, sortKey: newSortKey }).catch(() => { void loadTasks(); });
  }

  async function deleteTaskById(id: string) {
    setTasks(prev => { const next = prev.filter(t => t.id !== id); tasksRef.current = next; return next; });
    try { await api.deleteTask(id); } catch { void loadTasks(); }
  }

  async function createTask(draft: Partial<Task>): Promise<string | undefined> {
    try {
      const result = await api.createTask(draft as Parameters<typeof api.createTask>[0]);
      await loadTasks();
      return result?.task?.id;
    } catch {}
  }

  function openPanel(task: Task | null, tab: PanelState['tab'] = 'details', addColumnId?: TaskStatus) {
    // Direct panel opens (clicking a card) reset navigation history since
    // the user is starting a new navigation context.
    setNavHistory([]);
    setPanelState({ open: true, task, tab, addColumnId });
  }

  /** Navigate back through the task-ref history stack. */
  function goBack() {
    setNavHistory((prev) => {
      if (prev.length === 0) return prev;
      const prevTask = prev[prev.length - 1];
      const newHistory = prev.slice(0, -1);
      // Set the hash to the full 30-char task ID, suppress history push
      // to avoid creating a duplicate entry in the nav stack.
      suppressHistoryPushRef.current = true;
      consumedHashTaskRef.current = null;
      window.location.hash = `#task-${prevTask.id}`;
      // Also directly update panel state in case hashchange isn't triggered immediately
      setPanelState((p) => ({ ...p, open: true, task: prevTask, tab: 'details' }));
      return newHistory;
    });
  }

  function openFilePreview(name: string, url: string) {
    // HTML files open in a new tab for sandboxed preview; all others use the modal.
    if (/\.html?$/i.test(name)) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    setFilePreview({ open: true, name, url });
  }

  const taskSummary = buildTaskSummary(tasks, visibleCols, searchQuery.toLowerCase());
  const baseUrl = window.location.origin;

  const allTags = React.useMemo(() => {
    const set = new Set<string>();
    tasks.forEach(t => (t.tags ?? []).forEach(tag => set.add(tag)));
    return Array.from(set).sort();
  }, [tasks]);

  // Status changes filtered for the currently open task — fed to DetailPanel activity tab.
  const panelStatusChanges = React.useMemo(() => {
    const panelTaskId = panelState.task?.id;
    if (!panelTaskId) return [];
    return statusChangeLog
      .filter((e) => e.taskId === panelTaskId)
      .map(({ field, from, to, actor, timestamp, source }) => ({ field, from, to, actor, timestamp, source }));
  }, [panelState.task?.id, statusChangeLog]);

  const filteredTasks = React.useMemo(() => {
    let result = tasks;
    if (filterState.status !== 'all') {
      result = result.filter(t => t.status === filterState.status);
    }
    if (filterState.component) {
      result = result.filter(t => t.component === filterState.component);
    }
    if (filterState.type) {
      result = result.filter(t => t.type === filterState.type);
    }
    if (filterState.user) {
      result = result.filter(t => t.author === filterState.user);
    }
    if (filterState.tags && filterState.tags.length > 0) {
      result = result.filter(t => filterState.tags!.every(tag => (t.tags ?? []).includes(tag)));
    }
    return result;
  }, [tasks, filterState]);

  // Always computed at top level to satisfy Rules of Hooks — only used when experimentalAgents is enabled.
  const agentStatusMap = React.useMemo(() => new Map(agentRuns.map(r => [r.taskId, r.status])), [agentRuns]);

  const showLostConnectionOverlay = hadWsConnection && !wsConnected;

  return (
    <>
      {SAAS_MODE && !overlayDismissed && (
        <OnlineModeOverlay onClose={IS_ADMIN ? () => setOverlayDismissed(true) : undefined} />
      )}
      <Header
        projectName={projectName}
        missingProjectIconStyle="vibeflow"
        wsConnected={wsConnected}
        port={PORT}
        searchQuery={searchQuery}
        filterTags={filterState.tags}
        allTags={allTags}
        onToggleTag={(tag) => {
          const current = filterState.tags ?? [];
          const next = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag];
          setFilterState(prev => ({ ...prev, tags: next }));
        }}
        premiumUsage={premiumUsage}
        isLoading={isLoading}
        taskSummary={taskSummary}
        onSearchChange={setSearchQuery}
        onSettings={() => setSettingsOpen(true)}
        agentRuns={agentRuns}
        selectMode={selectMode}
        onToggleSelectMode={() => { setSelectMode(v => !v); setSelectedTaskIds(new Set()); }}
        agentQueueCount={agentRuns.filter(r => r.status === 'running' || r.status === 'queued').length}
        onOpenAgentQueue={() => setAgentQueueOpen(true)}
        experimentalAgents={appSettings.experimentalAgents}
      />

      <FilterBar
        tasks={tasks}
        filter={filterState}
        view={viewMode}
        onFilter={setFilterState}
        onViewChange={(mode) => {
          setViewMode(mode);
          void api.saveSettings({ ...appSettings, viewMode: mode });
          setAppSettings(prev => ({ ...prev, viewMode: mode }));
        }}
      />

      <div className="flex flex-1 overflow-hidden" style={{ minHeight: 0, position: 'relative' }}>
        {viewMode === 'list' ? (
          <KanbanListView
            tasks={filteredTasks}
            searchQuery={searchQuery}
            isLoading={isLoading}
            onOpenPanel={(task, tab) => openPanel(task, tab)}
            onAddTask={(status) => openPanel(null, 'details', status)}
            onDrop={(taskId, status) => patchTask(taskId, { status })}
            experimentalAgents={appSettings.experimentalAgents}
          />
        ) : (
          <KanbanBoard
            tasks={filteredTasks}
            visibleCols={visibleCols}
            searchQuery={searchQuery}
            isLoading={isLoading}
            onOpenPanel={(task, tab, colId) => openPanel(task, tab, colId)}
            onDrop={(taskId, status) => patchTask(taskId, { status })}
            onReorder={handleReorder}
            selectMode={selectMode}
            selectedTaskIds={selectedTaskIds}
            onToggleSelect={toggleSelect}
            agentStatuses={appSettings.experimentalAgents === true ? agentStatusMap : undefined}
            onRunSelectedAgents={appSettings.experimentalAgents === true ? runSelectedAgents : undefined}
            onExitSelectMode={() => { setSelectMode(false); setSelectedTaskIds(new Set()); }}
            experimentalAgents={appSettings.experimentalAgents}
          />
        )}

        {panelState.open && (
          <div
            id="detail-panel-container"
            style={{ width: panelWidth, zIndex: isResizingPanel ? 30 : 10 }}
            className={isResizingPanel ? 'resizing' : ''}
          >
            <div
              id="detail-panel-resize-handle"
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingPanel(true);
                document.body.classList.add('vibeflow-resizing-panel');
                const startX = e.clientX;
                const startWidth = panelWidth;
                const onMove = (ev: MouseEvent) => {
                  const next = startWidth - (ev.clientX - startX);
                  setPanelWidth(Math.max(360, Math.min(860, next)));
                };
                const onUp = (ev: MouseEvent) => {
                  setIsResizingPanel(false);
                  document.body.classList.remove('vibeflow-resizing-panel');
                  const finalWidth = Math.max(360, Math.min(860, startWidth - (ev.clientX - startX)));
                  void api.saveSettings({ ...appSettings, panelWidth: finalWidth });
                  setAppSettings(prev => ({ ...prev, panelWidth: finalWidth }));
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
            />
            <DetailPanel
              open={panelState.open}
              task={panelState.task}
              tab={panelState.tab}
              showLockIndicator={false}
              addColumnId={panelState.addColumnId}
              gitUserName={gitUserName}
              githubUrl={githubUrl}
              baseUrl={baseUrl}
              isResizing={isResizingPanel}
              api={api}
              onClose={() => { setNavHistory([]); setPanelState(p => ({ ...p, open: false })); }}
              onSave={async (updates) => {
                if (panelState.task) {
                  await patchTask(panelState.task.id, updates);
                }
                setPanelState(p => ({ ...p, open: false }));
              }}
              onCreate={async (draft) => {
                const taskId = await createTask(draft);
                setPanelState(p => ({ ...p, open: false }));
                return taskId;
              }}
              onDelete={async (id) => {
                await deleteTaskById(id);
                setPanelState(p => ({ ...p, open: false }));
              }}
              onPatch={patchTask}
              onFilePreview={openFilePreview}
              onGoBack={navHistory.length > 0 ? goBack : undefined}
              navBackLabel={navHistory.length > 0 ? navHistory[navHistory.length - 1].title : undefined}
              externalLocalChanges={panelStatusChanges}
              allTasks={tasks}
              agentRun={agentRuns.find(r => r.taskId === panelState.task?.id)}
              onRunAgent={runAgent}
              onStopAgent={stopAgent}
              onDequeueAgent={dequeueAgent}
              models={models}
              defaultModel={appSettings.defaultModel as string | undefined}
              perTypeModels={appSettings.perTypeModels as boolean | undefined}
              defaultModelBug={appSettings.defaultModelBug as string | undefined}
              defaultModelResearch={appSettings.defaultModelResearch as string | undefined}
              defaultModelTask={appSettings.defaultModelTask as string | undefined}
              agents={agents}
              experimentalAgents={appSettings.experimentalAgents}
              createBranch={appSettings.createBranch}
            />
          </div>
        )}

      </div>


      {appSettings.experimentalAgents === true && (
        <AgentQueuePanel
          open={agentQueueOpen}
          runs={agentRuns}
          onStop={stopAgent}
          onOpenTask={(taskId) => {
            const task = tasks.find((t) => t.id === taskId);
            if (task) { openPanel(task, 'agent'); setAgentQueueOpen(false); }
          }}
          onClose={() => setAgentQueueOpen(false)}
        />
      )}

      {showLostConnectionOverlay && createPortal(
        <div
          id="ws-lost-overlay"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            zIndex: 99999,
            background: 'rgba(2, 6, 23, 0.88)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            pointerEvents: 'all',
            cursor: 'not-allowed',
          }}
        >
          <div
            style={{
              width: 'min(420px, 92vw)',
              borderRadius: 14,
              border: '1px solid var(--p-border-s)',
              background: 'var(--p-card)',
              boxShadow: '0 16px 40px rgba(2,6,23,0.7)',
              padding: '20px 22px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              cursor: 'default',
              pointerEvents: 'auto',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--p-text-m)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ animation: 'spin 1.1s linear infinite', flexShrink: 0 }}
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--p-text)' }}>
                Connection Lost
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--p-text-m)', lineHeight: 1.6 }}>
              Real-time connection to the server was interrupted. Reconnecting in the background&hellip;
            </div>
          </div>
        </div>,
        document.body
      )}

      <SettingsModal
        open={settingsOpen}
        visibleCols={visibleCols}
        settings={appSettings}
        models={models}
        agents={agents}
        onClose={() => setSettingsOpen(false)}
        onSave={(cols, newSettings) => {
          setVisibleCols(cols);
          const updated = { ...appSettings, ...newSettings, visibleCols: cols };
          setAppSettings(updated);
          void api.saveSettings(updated as Record<string, unknown>);
        }}
      />

      <FilePreviewModal
        open={filePreview.open}
        name={filePreview.name}
        url={filePreview.url}
        onClose={() => setFilePreview(p => ({ ...p, open: false }))}
      />

    </>
  );
}
