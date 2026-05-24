import React from 'react';
import { X, Upload, Play, Square, Trash2 } from 'lucide-react';
import type { Task, Comment, FileEntry, TaskStatus, TaskType, Priority, KanbanApi, AgentRun } from '../types';
import { TypePicker } from './shared/TypePicker';
import { CommentsList } from './shared/CommentsList';
import type { LocalChange } from './shared/CommentsList';
import { FilesList } from './shared/FilesList';
import { TaskDetailsTab } from './shared/TaskDetailsTab';
import { CommentsInputArea } from './shared/CommentsInputArea';
import { ConfirmModal } from './ConfirmModal';
import { AgentTab } from './AgentTab';

import { getTaskTypeColor } from '../../task-types';

const PASTE_HINT_KEY = 'vibeflow-paste-hint-dismissed';

function PasteHintBanner({ storageKey = PASTE_HINT_KEY }: { storageKey?: string }) {
  const [visible, setVisible] = React.useState(() => {
    try { return !localStorage.getItem(storageKey); } catch { return true; }
  });

  if (!visible) return null;

  function dismiss() {
    try { localStorage.setItem(storageKey, '1'); } catch {}
    setVisible(false);
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', margin: '0 0 6px', borderRadius: 6, background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.18)', fontSize: 11, color: 'var(--p-blue-300)', flexShrink: 0 }}>
      <span style={{ flex: 1, lineHeight: 1.4 }}>💡 <strong>Tip:</strong> Paste screenshots or files anywhere in this panel — they attach automatically.</span>
      <button
        onClick={dismiss}
        title="Dismiss"
        style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--p-blue-300)', opacity: 0.7, display: 'flex', alignItems: 'center' }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
      >
        <X style={{ width: 12, height: 12 }} />
      </button>
    </div>
  );
}

type Tab = 'details' | 'comments' | 'files' | 'agent';

const STATUS_BUTTONS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog', label: 'backlog' },
  { id: 'todo', label: 'todo' },
  { id: 'in-progress', label: 'in-progress' },
  { id: 'review', label: 'review' },
  { id: 'done', label: 'done' },
];

interface Props {
  open: boolean;
  task: Task | null;
  tab: Tab;
  addColumnId?: TaskStatus;
  gitUserName?: string;
  githubUrl?: string | null;
  baseUrl: string;
  isResizing?: boolean;
  api: KanbanApi;
  onClose: () => void;
  onSave: (task: Task) => void;
  onCreate: (draft: Partial<Task>) => Promise<string | undefined>;
  onDelete: (taskId: string) => void;
  onPatch: (taskId: string, patch: Partial<Task>) => void;
  onFilePreview: (name: string, url: string) => void;
  onActivityChange?: (taskId: string | null, state: 'viewing' | 'editing' | 'locked') => void;
  showLockIndicator?: boolean;
  /** When set, the panel is read-only because another user holds the lock. */
  lockedByUser?: string | null;
  /** All tasks on the board — used to build the global tag pool for autocomplete. */
  allTasks?: Task[];
  /** Called when the user clicks the back button. Shown only when defined. */
  onGoBack?: () => void;
  externalLocalChanges?: LocalChange[];
  /** Label shown in the back button tooltip (the previous task title). */
  navBackLabel?: string;
  /** Monotonically increasing counter that triggers a comment/badge refetch when bumped. */
  commentVersion?: number;
  /** Active agent run for the currently open task, if any. */
  agentRun?: AgentRun;
  /** Request to start an agent on a task. */
  onRunAgent?: (taskId: string, model: string, agent?: string) => void;
  /** Request to stop a running agent. */
  onStopAgent?: (taskId: string) => void;
  /** Request to remove a queued agent run. */
  onDequeueAgent?: (taskId: string) => void;
  /** Available models from OpenCode CLI */
  models?: { id: string; label: string; provider: string; recommended?: boolean }[];
  /** Default model from user settings */
  defaultModel?: string;
  /** When true, use per-type default models */
  perTypeModels?: boolean;
  /** Default model for Bug tasks */
  defaultModelBug?: string;
  /** Default model for Research tasks */
  defaultModelResearch?: string;
  /** Default model for Task tasks */
  defaultModelTask?: string;
  /** Available agents from OpenCode CLI */
  agents?: { id: string; name: string; scope: string }[];
  /** When false, agent-related UI is hidden. */
  experimentalAgents?: boolean;
  /** When true, enforce branch name input when setting status to review. */
  createBranch?: boolean;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB — must match server limit

function compressImageToJpeg(source: Blob, quality = 0.8): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(source);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error('canvas unavailable')); return; }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => { if (blob) resolve(blob); else reject(new Error('canvas.toBlob failed')); },
        'image/jpeg',
        quality,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

export function DetailPanel({
  open, task, tab, addColumnId = 'todo',
  gitUserName = 'You', githubUrl, baseUrl,
  isResizing, api,
  onClose, onSave, onCreate, onDelete, onPatch,
  onFilePreview, onActivityChange, externalLocalChanges = [],
  showLockIndicator = true, lockedByUser,
  onGoBack, navBackLabel,
  commentVersion,
  allTasks = [],
  agentRun,
  onRunAgent,
  onStopAgent,
  onDequeueAgent,
  models,
  defaultModel,
  perTypeModels,
  defaultModelBug,
  defaultModelResearch,
  defaultModelTask,
  agents,
  experimentalAgents,
  createBranch,
}: Props) {
  const isAdd = !task;
  const typeColor = task ? getTaskTypeColor(task.type) : getTaskTypeColor('Task');
  const panelRef = React.useRef<HTMLElement>(null);
  const [pendingPasteFiles, setPendingPasteFiles] = React.useState<File[]>([]);
  const isResizingRef = React.useRef(false);
  const originalTitleRef = React.useRef('');
  const originalDescRef = React.useRef('');

  // Compute global tag pool from all tasks (stable reference)
  const allTags = React.useMemo(() => {
    const set = new Set<string>();
    for (const t of allTasks) for (const tag of t.tags ?? []) set.add(tag);
    return [...set].sort();
  }, [allTasks]);

  // Local form state
  const [activeTab, setActiveTab] = React.useState<Tab>(tab);
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [status, setStatus] = React.useState<TaskStatus>(addColumnId);
  const [type, setType] = React.useState<TaskType>('Task');
  const [priority, setPriority] = React.useState<Priority | ''>('');
  const [showDescPreview, setShowDescPreview] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [showCommentSendConfirm, setShowCommentSendConfirm] = React.useState(false);
  const [branchName, setBranchName] = React.useState('');
  const [showBranchPrompt, setShowBranchPrompt] = React.useState(false);
  const pendingReviewPatchRef = React.useRef<{ taskId: string; patch: Partial<Task> } | null>(null);

  // Agent tab state — initialized from task or default model so "Run Agent"
  // uses the displayed model even when the user never touches the dropdown.
  // Resolves default model: task.model → per-type default → overall default → first available model → ''
  const fallbackModel = models && models.length > 0 ? models[0].id : '';
  const resolvedDefaultModel = React.useMemo(() => {
    if (perTypeModels && task?.type) {
      if (task.type === 'Bug' && defaultModelBug) return defaultModelBug;
      if (task.type === 'Research' && defaultModelResearch) return defaultModelResearch;
      if (task.type === 'Task' && defaultModelTask) return defaultModelTask;
    }
    return defaultModel ?? fallbackModel;
  }, [perTypeModels, task?.type, defaultModel, defaultModelBug, defaultModelResearch, defaultModelTask, fallbackModel]);

  const [agentModel, setAgentModel] = React.useState(task?.model ?? resolvedDefaultModel);
  const [agentAgent, setAgentAgent] = React.useState(task?.agent ?? '');

  // When models load after the panel is open, apply the fallback default so
  // "Run Agent" uses the same model shown in the picker.
  React.useEffect(() => {
    if (!agentModel && resolvedDefaultModel) {
      setAgentModel(resolvedDefaultModel);
    }
  }, [resolvedDefaultModel, agentModel]);

  // Persist model/agent selection to the task when changed in the Agent tab
  const handleAgentModelChange = React.useCallback((model: string) => {
    setAgentModel(model);
    if (task && model !== task.model) {
      onPatch(task.id, { model });
    }
  }, [task, onPatch]);

  const handleAgentAgentChange = React.useCallback((agent: string) => {
    setAgentAgent(agent);
    if (task && agent !== task.agent) {
      onPatch(task.id, { agent });
    }
  }, [task, onPatch]);

  // Tab data
  const [comments, setComments] = React.useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = React.useState(false);
  const [commentsError, setCommentsError] = React.useState<string | null>(null);
  const [commentInput, setCommentInput] = React.useState('');
  const [commentSubmitting, setCommentSubmitting] = React.useState(false);

  const [files, setFiles] = React.useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = React.useState(false);
  const [filesError, setFilesError] = React.useState<string | null>(null);

  const [commentCount, setCommentCount] = React.useState(0);
  const commentsLoadGen = React.useRef(0);
  const [fileCount, setFileCount] = React.useState(0);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [localChanges, setLocalChanges] = React.useState<LocalChange[]>([]);
  const [draftTags, setDraftTags] = React.useState<string[]>([]);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  const autoSaveRef = React.useRef<() => void>(() => {});
  const commentInputRef = React.useRef('');
  const showCommentSendConfirmRef = React.useRef(false);

  // Keep commentInputRef in sync so the outside-click handler can check it without closure staling.
  React.useEffect(() => { commentInputRef.current = commentInput; }, [commentInput]);
  React.useEffect(() => { showCommentSendConfirmRef.current = showCommentSendConfirm; }, [showCommentSendConfirm]);

  // Keep resize ref in sync so the outside-click handler always reads current value
  // without being in the effect dependency array (avoids re-registering on each resize move).
  React.useEffect(() => { isResizingRef.current = isResizing ?? false; }, [isResizing]);

  // Notify parent when panel closes
  React.useEffect(() => {
    if (!open) {
      onActivityChange?.(null, 'viewing');
    }
  }, [open]);

  // Detect dirty state and notify parent with 'locked'
  React.useEffect(() => {
    if (!open || !task) return;
    const isDirty = title !== originalTitleRef.current || description !== originalDescRef.current;
    if (isDirty) {
      onActivityChange?.(task.id, 'locked');
    } else {
      onActivityChange?.(task.id, 'viewing');
    }
  }, [title, description, open, task?.id]);

  // Sync form when task/panel opens
  // Close panel when clicking outside (f831ac43)
  React.useEffect(() => {
    if (!open) return;
    function handleOutsideClick(e: MouseEvent) {
      if (isResizingRef.current) return;
      // Allow clicks on portaled autocomplete dropdowns (rendered outside the panel DOM).
      if ((e.target as Element)?.closest?.('[data-task-ref-suggest]')) return;
      // Allow clicks inside any modal overlay (FilePreviewModal, SettingsModal, AgentRunnerModal, etc.)
      // They render outside the panel DOM but should not close the panel.
      if ((e.target as Element)?.closest?.('.modal-backdrop')) return;
      // Allow clicks on portaled model picker dropdown
      if ((e.target as Element)?.closest?.('[data-model-picker-dropdown]')) return;
      // Allow clicks on portaled agent picker dropdown
      if ((e.target as Element)?.closest?.('[data-agent-picker-dropdown]')) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // If a "send comment?" modal is already shown, don't trigger another one
        if (showCommentSendConfirmRef.current) return;
        // If there's a pending comment, ask user rather than auto-close
        if (commentInputRef.current.trim().length > 0) {
          autoSaveRef.current();
          setShowCommentSendConfirm(true);
          return;
        }
        // Save any pending changes before closing (blur fires after mousedown, so save explicitly)
        autoSaveRef.current();
        onClose();
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open, onClose]);

  // Handle Escape key: check for pending comment before closing
  React.useEffect(() => {
    if (!open) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Don't interfere with Escape from inner text fields in the title (they handle Escape separately)
      // This listener handles the global Escape to close the panel
      if (showCommentSendConfirmRef.current) { setShowCommentSendConfirm(false); e.stopPropagation(); return; }
      if (commentInputRef.current.trim().length > 0) {
        e.stopPropagation();
        autoSaveRef.current();
        setShowCommentSendConfirm(true);
        return;
      }
    }
    document.addEventListener('keydown', handleEsc, { capture: true });
    return () => document.removeEventListener('keydown', handleEsc, { capture: true });
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    setActiveTab(tab);
    // Existing tasks open in preview mode; new tasks open in edit mode.
    setShowDescPreview(Boolean(task));
    setCommentInput('');
    setComments([]);
    setFiles([]);
    setCommentCount(0);
    setFileCount(0);
    setLocalChanges([]);
    setDraftTags([]);
    setAgentModel(task?.model ?? resolvedDefaultModel);
    setAgentAgent(task?.agent ?? '');
    setBranchName(task?.branchName ?? '');
    setShowBranchPrompt(false);
    pendingReviewPatchRef.current = null;

    if (task) {
      // Trim stored values so autoSave comparisons are consistent (prevents
      // spurious patches when the DB title/description has trailing whitespace).
      const trimmedTitle = (task.title ?? '').trim();
      const trimmedDesc = (task.description ?? '').trim();
      setTitle(trimmedTitle);
      setDescription(trimmedDesc);
      setStatus(task.status);
      setType(task.type ?? 'Task');
      setPriority(task.priority ?? '');
      originalTitleRef.current = trimmedTitle;
      originalDescRef.current = trimmedDesc;
      onActivityChange?.(task.id, 'viewing');
    } else {
      setTitle('');
      setDescription('');
      setStatus(addColumnId);
      setType('Task');
      setPriority('');
    }

    if (task) {
      // Load badge counts eagerly
      void loadBadgeCounts(task.id);
      // Load files eagerly so the details tab screenshot preview is always up to date
      void loadFiles(task.id);
    }
    setTimeout(() => titleInputRef.current?.focus(), 50);
  }, [open, task?.id, tab]);

  // Load content when switching tabs
  React.useEffect(() => {
    if (!open || !task) return;
    if (activeTab === 'comments') { loadComments(task.id); loadFiles(task.id); }
    else if (activeTab === 'files') loadFiles(task.id);
  }, [activeTab, open, task?.id]);

  // Sync form fields when the task prop changes externally (e.g., another user patched
  // the title/description) — but only if the local form has no unsaved changes.
  React.useEffect(() => {
    if (!open || !task) return;
    const localDirty =
      title !== originalTitleRef.current ||
      description !== originalDescRef.current;
    if (localDirty) return; // don't overwrite user's in-progress edits
    const trimmedTitle = (task.title ?? '').trim();
    const trimmedDesc = (task.description ?? '').trim();
    if (trimmedTitle !== originalTitleRef.current || trimmedDesc !== originalDescRef.current) {
      setTitle(trimmedTitle);
      setDescription(trimmedDesc);
      originalTitleRef.current = trimmedTitle;
      originalDescRef.current = trimmedDesc;
    }
    if (task.status && task.status !== status) setStatus(task.status);
    if (task.type && task.type !== type) setType(task.type);
    if (task.priority !== undefined && task.priority !== priority) setPriority(task.priority ?? '');
    if (task.model && task.model !== agentModel) setAgentModel(task.model);
    if (task.agent && task.agent !== agentAgent) setAgentAgent(task.agent);
    if (task.branchName && task.branchName !== branchName) setBranchName(task.branchName);
  }, [task?.title, task?.description, task?.status, task?.type, task?.priority, task?.model, task?.agent, task?.branchName]);

  // Refetch comments/badge counts when another user adds a comment (commentVersion bumps)
  React.useEffect(() => {
    if (!open || !task || commentVersion === undefined) return;
    if (activeTab === 'comments') { loadComments(task.id); }
    else { void loadBadgeCounts(task.id); }
  }, [commentVersion]);

  async function loadBadgeCounts(taskId: string) {
    try {
      const [cd, fd] = await Promise.all([
        api.getComments(taskId),
        api.getFiles(taskId),
      ]);
      setCommentCount(cd.comments?.length ?? 0);
      setFileCount(fd.files?.length ?? 0);
    } catch {}
  }

  async function loadComments(taskId: string) {
    const gen = ++commentsLoadGen.current;
    setCommentsLoading(true);
    setCommentsError(null);
    try {
      const data = await api.getComments(taskId);
      if (commentsLoadGen.current !== gen) return;
      setComments(data.comments ?? []);
      setCommentCount(data.comments?.length ?? 0);
    } catch {
      if (commentsLoadGen.current !== gen) return;
      setCommentsError('failed');
    } finally {
      if (commentsLoadGen.current === gen) setCommentsLoading(false);
    }
  }

  async function loadFiles(taskId: string) {
    setFilesLoading(true);
    setFilesError(null);
    try {
      const data = await api.getFiles(taskId);
      setFiles(data.files ?? []);
      setFileCount(data.files?.length ?? 0);
    } catch {
      setFilesError('failed');
    } finally {
      setFilesLoading(false);
    }
  }

  async function handleSave() {
    if (!title.trim()) { titleInputRef.current?.focus(); return; }
    // Auto-submit pending comment when saving an existing task
    if (!isAdd && commentInput.trim()) {
      await handleSubmitComment();
    }
    if (isAdd) {
      const newTaskId = await onCreate({ title: title.trim(), description: description.trim() || title.trim(), status, type, priority: priority || undefined, selector: '/', tags: draftTags.length > 0 ? draftTags : undefined });
      // Upload any files pasted during task creation
      if (newTaskId && pendingPasteFiles.length > 0) {
        for (const file of pendingPasteFiles) {
          await api.uploadFile(newTaskId, file).catch(() => null);
        }
        setPendingPasteFiles([]);
      }
      onClose();
    } else {
      autoSave();
    }
  }

  function autoSave() {
    if (!task || isAdd) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    const prevTitle = originalTitleRef.current;
    const prevDesc = originalDescRef.current;
    const titleChanged = trimmedTitle !== prevTitle;
    const descChanged = description.trim() !== prevDesc;
    if (!titleChanged && !descChanged) return;
    if (titleChanged) {
      recordChange('title', prevTitle, trimmedTitle);
    }
    if (descChanged) {
      recordChange('description', prevDesc, description.trim());
    }
    onPatch(task.id, { title: trimmedTitle, description: description.trim(), type, priority: priority || undefined });
    originalTitleRef.current = trimmedTitle;
    originalDescRef.current = description.trim();
  }

  // Keep autoSaveRef always current so outside-click handler uses latest state
  autoSaveRef.current = autoSave;

  function recordChange(field: string, from: string, to: string) {
    if (from === to) return;
    setLocalChanges(prev => [...prev, { field, from, to, actor: gitUserName, timestamp: new Date().toISOString() }]);
  }

  async function handleSubmitComment() {
    if (!task || !commentInput.trim()) return;
    setCommentSubmitting(true);
    try {
      await api.addComment(task.id, commentInput.trim());
      setCommentInput('');
      await loadComments(task.id);
    } finally {
      setCommentSubmitting(false);
    }
  }

  async function handleEditComment(comment: Comment, newText: string) {
    if (!task) return;
    await api.updateComment(task.id, comment.id, newText);
    await loadComments(task.id);
  }

  async function handleDeleteComment(comment: Comment) {
    if (!task) return;
    await api.deleteComment(task.id, comment.id);
    await loadComments(task.id);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!task) return;
    const taskId = task.id;
    setUploadError(null);
    for (const file of Array.from(e.target.files ?? [])) {
      if (!file.type.startsWith('image/') && file.size > MAX_UPLOAD_BYTES) {
        setUploadError(`"${file.name}" exceeds the 5 MB limit and was skipped.`);
        continue;
      }
      let toUpload: File;
      if (file.type.startsWith('image/')) {
        const compressed = await compressImageToJpeg(file);
        const jpegName = file.name.replace(/\.(png|bmp|gif|webp|tiff?)$/i, '.jpg');
        toUpload = new File([compressed], jpegName, { type: 'image/jpeg' });
      } else {
        toUpload = file;
      }
      await api.uploadFile(taskId, toUpload);
    }
    e.target.value = '';
    await loadFiles(taskId);
    void loadBadgeCounts(taskId);
  }

  async function uploadPastedImage(blob: Blob) {
    if (!task) return;
    setUploadError(null);
    const compressed = await compressImageToJpeg(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `paste-${ts}.jpg`;
    const file = new File([compressed], filename, { type: 'image/jpeg' });
    await api.uploadFile(task.id, file);
    await loadFiles(task.id);
    void loadBadgeCounts(task.id);
  }

  // Centralized paste handler — handles images, files, and file-system paths
  // Uses a document-level listener (not onPaste) so paste works even when no editable element is focused
  async function handleClipboardPaste(clipboardData: DataTransfer) {
    if (!task) return;
    const items = Array.from(clipboardData.items);

    // Images get their own named file (paste-<timestamp>.png)
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (imageItem) {
      const blob = imageItem.getAsFile();
      if (blob) await uploadPastedImage(blob);
      return;
    }

    // Any other pasted files (e.g. text/csv, application/pdf, …) are uploaded as-is
    const fileItems = items.filter(item => item.kind === 'file' && !item.type.startsWith('image/'));
    if (fileItems.length > 0) {
      for (const item of fileItems) {
        const file = item.getAsFile();
        if (file) await api.uploadFile(task.id, file);
      }
      await loadFiles(task.id);
      void loadBadgeCounts(task.id);
      return;
    }
  }

  // Attach document-level paste listener so paste works regardless of focused element
  // Works for both existing tasks and "create new task" mode (isAdd=true)
  React.useEffect(() => {
    if (!open) return;
    function onDocPaste(e: ClipboardEvent) {
      if (!e.clipboardData) return;
      // Don't intercept paste when inside an editable text field expecting text input
      const target = e.target as HTMLElement;
      const isTextInput = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable;
      if (isTextInput) {
        // Still intercept images/files even in text fields (they can't accept those anyway)
        const items = Array.from(e.clipboardData.items);
        const hasImageOrFile = items.some(it => it.kind === 'file');
        if (!hasImageOrFile) return;
      }
      e.preventDefault();
      // In "create task" mode: buffer pasted files for upload after task creation
      if (!task) {
        const items = Array.from(e.clipboardData.items);
        const imageItem = items.find(it => it.type.startsWith('image/'));
        if (imageItem) {
          const blob = imageItem.getAsFile();
          if (blob) {
            void (async () => {
              const compressed = await compressImageToJpeg(blob);
              const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              const file = new File([compressed], `paste-${ts}.jpg`, { type: 'image/jpeg' });
              setPendingPasteFiles(prev => [...prev, file]);
            })();
          }
        }
        return;
      }
      void handleClipboardPaste(e.clipboardData);
    }
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
  }, [open, task?.id]);

  async function handleDeleteFile(f: FileEntry) {
    if (!task) return;
    await api.deleteFile(task.id, f.name);
    await loadFiles(task.id);
    void loadBadgeCounts(task.id);
  }

  async function handleDeleteScreenshot(name: string) {
    if (!task) return;
    await api.deleteFile(task.id, name);
    const nextFiles = (task.files ?? []).filter((f) => f.name !== name);
    onPatch(task.id, { files: nextFiles });
    await loadFiles(task.id);
    void loadBadgeCounts(task.id);
  }

  function handleStatusClick(s: TaskStatus) {
    setStatus(s);
    if (isAdd) {
      return;
    }
    if (!task) {
      return;
    }

    // When createBranch is ON and setting status to review, enforce branch name
    if (createBranch && s === 'review' && !branchName.trim()) {
      // Store the pending patch and show the branch prompt
      pendingReviewPatchRef.current = { taskId: task.id, patch: { status: s } };
      setShowBranchPrompt(true);
      return;
    }

    const patch: Partial<Task> = { status: s };
    if (branchName.trim()) patch.branchName = branchName.trim();
    onPatch(task.id, patch);
  }

  function handleApplyBranchAndReview() {
    if (!pendingReviewPatchRef.current || !task) return;
    if (!branchName.trim()) return;
    const patch: Partial<Task> = { ...pendingReviewPatchRef.current.patch, branchName: branchName.trim() };
    onPatch(task.id, patch);
    setShowBranchPrompt(false);
    pendingReviewPatchRef.current = null;
  }

  function handleCancelBranchPrompt() {
    setShowBranchPrompt(false);
    pendingReviewPatchRef.current = null;
    // Revert status back from review to previous status
    if (task) setStatus(task.status);
  }

  const activeStatusClass = (s: TaskStatus) => {
    if (s !== status) return 'dp-status-btn';
    return `dp-status-btn active-${s}`;
  };

  // Centralized close handler — shows "send comment?" confirm if there's a pending comment
  function handleCloseRequest() {
    if (showCommentSendConfirmRef.current) return;
    if (commentInputRef.current.trim().length > 0) {
      autoSaveRef.current();
      setShowCommentSendConfirm(true);
      return;
    }
    autoSaveRef.current();
    onClose();
  }

  const isLocked = open && task != null && (
    title !== originalTitleRef.current ||
    description !== originalDescRef.current
  );

  const mergedLocalChanges = React.useMemo(() => {
    const changes = [...externalLocalChanges, ...localChanges].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const deduped: LocalChange[] = [];
    for (const change of changes) {
      const duplicate = deduped.some((existing) => (
        existing.field === change.field &&
        existing.from.toLowerCase() === change.from.toLowerCase() &&
        existing.to.toLowerCase() === change.to.toLowerCase() &&
        existing.actor === change.actor &&
        Math.abs(new Date(existing.timestamp).getTime() - new Date(change.timestamp).getTime()) <= 3000
      ));
      if (!duplicate) deduped.push(change);
    }
    return deduped;
  }, [externalLocalChanges, localChanges]);

  const remoteLocked = !isAdd && !!lockedByUser;

  return (
    <>
    <aside
      id="detail-panel"
      className="open"
      ref={panelRef}
    >
      {remoteLocked && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(234,88,12,0.12)', border: '1px solid rgba(234,88,12,0.25)', borderRadius: 6, margin: '8px 12px 0', fontSize: 12, color: '#f97316', fontWeight: 500 }}>
          🔒 Locked by <strong>{lockedByUser}</strong> — editing disabled until they finish.
        </div>
      )}
      {/* Header */}
      <div className="dp-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          {onGoBack && (
            <button
              id="dp-back"
              onClick={onGoBack}
              title={navBackLabel ? `Back to: ${navBackLabel}` : 'Go back'}
              style={{ width: 26, height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: '1px solid var(--p-border-t)', background: 'transparent', color: 'var(--p-text-g)', cursor: 'pointer', transition: 'background .12s,color .12s', fontSize: 14, lineHeight: 1 }}
              onMouseOver={(e) => { e.currentTarget.style.background = 'var(--p-border)'; e.currentTarget.style.color = 'var(--p-blue-300)'; e.currentTarget.style.borderColor = 'var(--p-blue)'; }}
              onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--p-text-g)'; e.currentTarget.style.borderColor = 'var(--p-border-t)'; }}
            >
              ←
            </button>
          )}
          <TypePicker id="dp-type-picker" value={type} disabled={remoteLocked} onChange={(newType) => {
            if (!isAdd && task && newType !== type) recordChange('type', type, newType);
            setType(newType);
            if (!isAdd && task) onPatch(task.id, { type: newType });
          }} />
          <input
            id="dp-title"
            ref={titleInputRef}
            className="dp-input"
            type="text"
            placeholder="Task title…"
            value={title}
            readOnly={remoteLocked}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); handleCloseRequest(); }
              if (e.key === 'Enter' && isAdd) void handleSave();
            }}
            style={{ flex: 1, fontSize: 14, fontWeight: 600, padding: '4px 8px', borderColor: 'transparent', background: 'transparent' }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--p-blue)'; e.currentTarget.style.background = 'var(--p-input)'; }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'transparent';
              e.currentTarget.style.background = 'transparent';
              if (!isAdd) autoSave();
            }}
          />
          {!isAdd && title !== originalTitleRef.current && title.trim() !== '' && (
            <button
              type="button"
              title="Discard title changes"
              onMouseDown={(e) => { e.preventDefault(); setTitle(originalTitleRef.current); }}
              style={{ width: 20, height: 20, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: '1px solid var(--p-border-t)', background: 'none', color: 'var(--p-text-g)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--p-amber-300)'; e.currentTarget.style.borderColor = 'var(--p-amber-300)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--p-text-g)'; e.currentTarget.style.borderColor = 'var(--p-border-t)'; }}
            >↩</button>
          )}
          <button
            id="dp-close"
            onClick={handleCloseRequest}
            style={{ width: 26, height: 26, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--p-text-g)', cursor: 'pointer', transition: 'background .12s,color .12s', pointerEvents: 'auto' }}
            onMouseOver={(e) => { e.currentTarget.style.background = 'var(--p-border)'; e.currentTarget.style.color = 'var(--p-text-m)'; }}
            onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--p-text-g)'; }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
          {showLockIndicator && isLocked && task && (
            <span
              id="dp-lock-indicator"
              title={`Locked by ${gitUserName} — unsaved changes`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
                borderRadius: 999, padding: '2px 7px', fontSize: 10, fontWeight: 600,
                border: '1px solid rgba(244,114,182,0.35)', color: '#f9a8d4',
                background: 'rgba(157,23,77,0.28)',
              }}
            >
              🔒 Locked
            </span>
          )}
        </div>

        {/* Status buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...(remoteLocked ? { pointerEvents: 'none' as const, opacity: 0.6 } : {}) }}>
          <span style={{ fontSize: 10, color: 'var(--p-text-g)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</span>
          {STATUS_BUTTONS.map(s => (
            <button key={s.id} className={activeStatusClass(s.id)} data-status={s.id} onClick={() => handleStatusClick(s.id)}>{s.label}</button>
          ))}
        </div>

        {/* Branch name prompt when createBranch is ON and setting to review */}
        {showBranchPrompt && !remoteLocked && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)', fontSize: 12 }}>
            <span style={{ color: 'var(--p-purple-300)', fontWeight: 500, whiteSpace: 'nowrap' }}>Branch name:</span>
            <input
              id="dp-branch-name"
              type="text"
              placeholder="e.g. feat/add-hover-effect"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && branchName.trim()) handleApplyBranchAndReview(); if (e.key === 'Escape') handleCancelBranchPrompt(); }}
              autoFocus
              style={{ flex: 1, fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--p-border)', background: 'var(--p-input)', color: 'var(--p-text)', fontFamily: 'monospace' }}
            />
            <button
              onClick={handleApplyBranchAndReview}
              disabled={!branchName.trim()}
              style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid var(--p-purple)', background: branchName.trim() ? 'var(--p-purple)' : 'var(--p-border)', color: '#fff', fontSize: 11, fontWeight: 600, cursor: branchName.trim() ? 'pointer' : 'not-allowed', transition: 'background .12s' }}
            >Apply & Review</button>
            <button
              onClick={handleCancelBranchPrompt}
              style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--p-border)', background: 'transparent', color: 'var(--p-text-g)', fontSize: 11, cursor: 'pointer' }}
            >Cancel</button>
          </div>
        )}
      </div>

      {/* Tabs (hidden in add mode) */}
      {!isAdd && (
        <div className="dp-tabs" id="dp-tabs-row">
          <button className={`dp-tab${activeTab === 'details' ? ' active' : ''}`} id="dp-tab-details" onClick={() => setActiveTab('details')}>Details</button>
          <button className={`dp-tab${activeTab === 'comments' ? ' active' : ''}`} id="dp-tab-activity" onClick={() => setActiveTab('comments')}>
            Activity {commentCount > 0 && <span id="dp-activity-count" style={{ color: 'var(--p-text-g)', fontSize: 10 }}>({commentCount})</span>}
          </button>
          <button className={`dp-tab${activeTab === 'files' ? ' active' : ''}`} id="dp-tab-files" onClick={() => setActiveTab('files')}>
            Files {fileCount > 0 && <span id="dp-file-count" style={{ color: 'var(--p-text-g)', fontSize: 10 }}>({fileCount})</span>}
          </button>
          {experimentalAgents === true && (
            <button
              className={`dp-tab${activeTab === 'agent' ? ' active' : ''}`}
              id="dp-tab-agent"
              onClick={() => setActiveTab('agent')}
              style={{ color: activeTab === 'agent' ? '#c4b5fd' : undefined, borderBottomColor: activeTab === 'agent' ? '#a78bfa' : undefined }}
            >
              🤖 Agent
              {agentRun && agentRun.status !== 'idle' && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 14, height: 12, borderRadius: 10, fontSize: 9, fontWeight: 700,
                  background: '#a78bfa', color: '#fff', marginLeft: 4,
                }}>
                  {agentRun.status === 'running' ? '●' : agentRun.status === 'queued' ? '⏳' : '✓'}
                </span>
              )}
            </button>
          )}
        </div>
      )}

      {/* Body */}
      <div className="dp-body">
        {!isAdd && <PasteHintBanner />}
        {/* ── Details pane ── */}
        <div className="dp-pane" id="dp-details-pane" style={{ display: (!task || activeTab === 'details') ? '' : 'none' }}>
          <div style={remoteLocked ? { pointerEvents: 'none', opacity: 0.6, flexShrink: 0 } : { flexShrink: 0 }}>
          <TaskDetailsTab
            task={task}
            description={description}
            setDescription={setDescription}
            showDescPreview={showDescPreview}
            setShowDescPreview={setShowDescPreview}
            priority={priority}
            setPriority={setPriority}
            onDescriptionBlur={isAdd ? undefined : autoSave}
            onDescriptionDiscard={isAdd ? undefined : () => {
              setDescription(originalDescRef.current);
              setShowDescPreview(true);
            }}
            originalDescription={isAdd ? undefined : originalDescRef.current}
            onPriorityChange={isAdd ? undefined : (p) => { if (task) { if (p !== priority) recordChange('priority', priority || '—', p || '—'); onPatch(task.id, { priority: p || undefined }); } }}
            githubUrl={githubUrl}
            onFilePreview={onFilePreview}
            onDeleteScreenshot={handleDeleteScreenshot}
            onPatch={onPatch}
            liveFiles={files.length > 0 || filesLoading ? files : undefined}
            allTags={allTags}
            overrideTags={isAdd ? draftTags : undefined}
            onTagsChange={isAdd ? setDraftTags : undefined}
          />
          </div>
          {!isAdd && task && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0, marginTop: 12, borderTop: '1px solid var(--p-border)', paddingTop: 10 }}>
              <DpMetaRow task={task} />
            </div>
          )}
        </div>

        {/* ── Activity pane ── */}
        <div className="dp-pane" id="dp-activity-pane" style={{ display: activeTab === 'comments' && !isAdd ? '' : 'none' }}>
          {/* Comment input at top */}
          <div style={{ borderBottom: '1px solid var(--p-border)', paddingBottom: 8, flexShrink: 0 }}>
            <CommentsInputArea
              commentInput={commentInput}
              setCommentInput={setCommentInput}
              commentSubmitting={commentSubmitting}
              onSubmit={() => void handleSubmitComment()}
              baseRows={2}
            />
          </div>
          <CommentsList
            comments={comments}
            files={files}
            localChanges={mergedLocalChanges}
            loading={commentsLoading}
            error={commentsError}
            gitUserName={gitUserName}
            taskAuthorName={task?.authorName}
            baseUrl={baseUrl}
            taskId={task?.id}
            taskCreatedAt={task?.createdAt}
            taskUpdatedAt={task?.updatedAt}
            onEdit={handleEditComment}
            onDelete={handleDeleteComment}
            onDeleteFile={handleDeleteFile}
            onFilePreview={onFilePreview}
          />
        </div>

        {/* ── Files pane ── */}
        <div
          className="dp-pane"
          id="dp-files-pane"
          style={{ display: activeTab === 'files' && !isAdd ? '' : 'none' }}
        >
          <FilesList
            files={files}
            loading={filesLoading}
            error={filesError}
            baseUrl={baseUrl}
            onPreview={(f) => onFilePreview(f.name, f.linkedPath ? `${baseUrl}/api/tasks/${task?.id}/files/${encodeURIComponent(f.name)}` : `${baseUrl}${f.url}`)}
            onDelete={remoteLocked ? undefined : handleDeleteFile}
          />
          <div style={{ borderTop: '1px solid var(--p-border)', paddingTop: 8, flexShrink: 0, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', ...(remoteLocked ? { pointerEvents: 'none' as const, opacity: 0.5 } : {}) }}>
            {uploadError && (
              <div style={{ width: '100%', fontSize: 11, color: 'var(--p-red)', background: 'rgba(255,80,80,0.08)', border: '1px solid rgba(255,80,80,0.2)', borderRadius: 5, padding: '4px 8px' }}>
                {uploadError}
              </div>
            )}
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '6px 10px', background: 'var(--p-card)', border: '1px solid var(--p-border)', borderRadius: 8, color: 'var(--p-text-m)', fontSize: 12, transition: 'all .15s' }}
              onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--p-border-t)'; e.currentTarget.style.color = 'var(--p-text)'; }}
              onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--p-border)'; e.currentTarget.style.color = 'var(--p-text-m)'; }}
            >
              <Upload style={{ width: 12, height: 12 }} />
              Upload
              <input id="dp-file-upload" type="file" style={{ display: 'none' }} multiple onChange={handleFileUpload} />
            </label>
            <span style={{ fontSize: 11, color: 'var(--p-border-t)', marginLeft: 'auto' }}>or paste image</span>
          </div>
        </div>

        {/* ── Agent pane ── */}
        {experimentalAgents === true && (
          <div
            className="dp-pane"
            id="dp-agent-pane"
            style={{ display: activeTab === 'agent' && !isAdd && task ? '' : 'none' }}
          >
            {task && (
              <AgentTab
                task={task}
                run={agentRun}
                onRun={(taskId, model, agent) => onRunAgent?.(taskId, model, agent)}
                onStop={onStopAgent ?? (() => {})}
                onDequeue={onDequeueAgent ?? (() => {})}
                models={models}
                defaultModel={defaultModel}
                onModelChange={handleAgentModelChange}
                agents={agents}
                onAgentChange={handleAgentAgentChange}
              />
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="dp-footer">
        {!isAdd && (
          <button
            id="dp-delete"
            onClick={() => setShowDeleteConfirm(true)}
            style={{ color: 'var(--p-red)', background: 'none', border: '1px solid var(--p-border-t)', borderRadius: 7, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', transition: 'all .15s' }}
            onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--p-red)'; }}
            onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--p-border-t)'; }}
          >Delete</button>
        )}
        <div style={{ flex: 1 }} />
        {isAdd ? (
          <>
            {pendingPasteFiles.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--p-blue-300)', marginRight: 8, background: 'rgba(37,99,235,0.1)', border: '1px solid rgba(37,99,235,0.25)', borderRadius: 6, padding: '3px 8px' }}>
                📎 {pendingPasteFiles.length} screenshot{pendingPasteFiles.length !== 1 ? 's' : ''} will attach on save
              </span>
            )}
            <button
              id="dp-cancel"
              onClick={onClose}
              style={{ padding: '5px 14px', borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: '1px solid var(--p-border-t)', background: 'var(--p-border)', color: 'var(--p-text-sub)', fontFamily: 'inherit', transition: 'all .15s' }}
              onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--p-text-g)'; }}
              onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--p-border-t)'; }}
            >Cancel</button>
            <button
              id="dp-save"
              onClick={() => void handleSave()}
              style={{ padding: '5px 18px', borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: '1px solid var(--p-blue-700)', background: 'var(--p-blue)', color: 'var(--p-white)', fontFamily: 'inherit', transition: 'background .15s' }}
              onMouseOver={(e) => { e.currentTarget.style.background = 'var(--p-blue-700)'; }}
              onMouseOut={(e) => { e.currentTarget.style.background = 'var(--p-blue)'; }}
            >Add Task</button>
          </>
        ) : experimentalAgents === true && activeTab === 'agent' && task ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flex: 1 }}>
            {(!agentRun || agentRun.status === 'idle') && (
              <button
                id="dp-run-agent"
                onClick={() => onRunAgent?.(task.id, agentModel, agentAgent || undefined)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '5px 14px', borderRadius: 7, border: '1px solid var(--p-purple)',
                  background: 'var(--p-purple)', color: '#fff', fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', transition: 'background .12s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#9333ea'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--p-purple)'; }}
              >
                <Play style={{ width: 12, height: 12 }} />
                Run Agent
              </button>
            )}
            {agentRun?.status === 'running' && (
              <button
                id="dp-stop-agent"
                onClick={() => onStopAgent?.(task.id)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '5px 14px', borderRadius: 7, border: '1px solid var(--p-red)',
                  background: 'color-mix(in srgb, var(--p-red) 15%, transparent)', color: 'var(--p-red)',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'background .12s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--p-red) 25%, transparent)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--p-red) 15%, transparent)'; }}
              >
                <Square style={{ width: 12, height: 12 }} />
                Stop
              </button>
            )}
            {agentRun?.status === 'queued' && (
              <button
                id="dp-dequeue-agent"
                onClick={() => onDequeueAgent?.(task.id)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '5px 14px', borderRadius: 7, border: '1px solid var(--p-red)',
                  background: 'color-mix(in srgb, var(--p-red) 15%, transparent)', color: 'var(--p-red)',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'background .12s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--p-red) 25%, transparent)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--p-red) 15%, transparent)'; }}
              >
                <Trash2 style={{ width: 12, height: 12 }} />
                Dequeue
              </button>
            )}
          </div>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--p-text-g)', padding: '5px 4px' }}>Changes are saved automatically</span>
        )}
      </div>
      <ConfirmModal
        open={showDeleteConfirm}
        title="Delete task?"
        message={`You are about to permanently delete "${task?.title || 'this task'}". This action cannot be undone.`}
        confirmLabel="Delete task"
        onConfirm={() => { setShowDeleteConfirm(false); onDelete(task!.id); onClose(); }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </aside>
    {showCommentSendConfirm && (
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 201, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', background: 'rgba(2,12,27,0.80)' }}
      >
        <div style={{ background: 'var(--p-surface)', border: '1px solid var(--p-border-s)', borderRadius: 16, padding: '28px 32px', width: '100%', maxWidth: 480, boxShadow: 'var(--p-shadow-lg)', position: 'relative' }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
            <Upload style={{ width: 20, height: 20, color: 'var(--p-purple)' }} />
          </div>
          <h2 style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 700, color: 'var(--p-text)' }}>Send comment?</h2>
          <p style={{ margin: '0 0 22px', fontSize: 13, color: 'var(--p-text-f)', lineHeight: 1.6 }}>
            You have an unsent comment. Do you want to send it before closing?
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => { setShowCommentSendConfirm(false); void handleSubmitComment().then(() => onClose()); }}
              style={{ flex: 1, padding: '9px 14px', borderRadius: 8, background: 'var(--p-purple)', border: 'none', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >Send &amp; Close</button>
            <button
              type="button"
              onClick={() => { setShowCommentSendConfirm(false); setCommentInput(''); onClose(); }}
              style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--p-hover)', border: '1px solid var(--p-border)', color: 'var(--p-text-m)', fontSize: 13, cursor: 'pointer' }}
            >Discard &amp; Close</button>
            <button
              type="button"
              onClick={() => setShowCommentSendConfirm(false)}
              style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--p-hover)', border: '1px solid var(--p-border)', color: 'var(--p-text-m)', fontSize: 13, cursor: 'pointer' }}
            >Keep editing</button>
          </div>
        </div>
      </div>
    )}
  </>
  );
}

function DpMetaRow({ task }: { task: Task }) {
  const items: React.ReactNode[] = [];

  if (task.component) {
    items.push(
      <span key="component" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', background: 'color-mix(in srgb, var(--p-purple) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--p-purple) 36%, transparent)', borderRadius: 100, fontSize: 10, color: 'var(--p-purple-300)', fontFamily: 'monospace' }}>
        ⬡ {task.component}
      </span>
    );
  }

  const hasSource = task.file || (task.selector && task.selector !== '/') || task.cssSelector;
  if (hasSource) {
    let fileLine = task.file ?? '';
    if (task.line != null) fileLine += `:${task.line}`;
    if (task.col != null) fileLine += `:${task.col}`;
    const selectorText = task.cssSelector ?? ((task.selector && task.selector !== '/') ? task.selector : '');
    const sourceText = fileLine || selectorText;
    if (sourceText) {
      const display = sourceText.length > 40 ? `…${sourceText.slice(-40)}` : sourceText;
      const urlDisplay = task.url ? (task.url.length > 30 ? `…${task.url.slice(-30)}` : task.url) : '';
      items.push(
        <span key="source" style={{ display: 'inline-flex', alignItems: 'center', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid color-mix(in srgb, var(--p-blue) 15%, transparent)', fontSize: 10, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
          <span title={[fileLine, selectorText].filter(Boolean).join(' · ')} style={{ padding: '2px 6px', background: 'color-mix(in srgb, var(--p-blue) 10%, transparent)', color: 'var(--p-blue-300)' }}>{display}</span>
          {urlDisplay && <span title={task.url} style={{ padding: '2px 6px', background: 'color-mix(in srgb, var(--p-border) 72%, transparent)', color: 'var(--p-text-g)', borderLeft: '1px solid color-mix(in srgb, var(--p-blue) 18%, transparent)' }}>{urlDisplay}</span>}
        </span>
      );
    }
  } else if (task.url) {
    const urlDisplay = task.url.length > 40 ? `…${task.url.slice(-40)}` : task.url;
    items.push(
      <span key="url" className="dp-source-pill" title={task.url}>{urlDisplay}</span>
    );
  }

  if (task.reportBack) {
    items.push(
      <span key="rb" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', background: 'color-mix(in srgb, var(--p-purple) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--p-purple) 24%, transparent)', borderRadius: 100, fontSize: 10, color: 'var(--p-purple-300)' }}>↩ report back</span>
    );
  }

  if (task.branchName) {
    items.push(
      <span key="branch" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', background: 'color-mix(in srgb, var(--p-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--p-green) 24%, transparent)', borderRadius: 100, fontSize: 10, color: 'var(--p-green-300)', fontFamily: 'monospace' }}>
        ⎇ {task.branchName}
      </span>
    );
  }

  return <div id="dp-meta-row" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1 }}>{items}</div>;
}
