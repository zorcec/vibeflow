import React from "react";
import { X, Upload, Maximize2, Minimize2 } from "lucide-react";
import {
  TASK_DESCRIPTION_MAX,
  formatDescriptionTooLong,
} from "@vibeflow-tools/shared";
import type {
  Task,
  Comment,
  FileEntry,
  TaskStatus,
  TaskType,
  Priority,
  KanbanApi,
  PresenceArea,
  PresenceEntry,
  DescriptionDocBinding,
} from "../types";
import { TypePicker } from "./shared/TypePicker";
import { CommentsList } from "./shared/CommentsList";
import type { LocalChange } from "./shared/CommentsList";
import { FilesList } from "./shared/FilesList";
import { TaskDetailsTab } from "./shared/TaskDetailsTab";
import { CommentsInputArea } from "./shared/CommentsInputArea";
import { ConfirmModal } from "./ConfirmModal";
import RelationsSection from "./RelationsSection";
import { VerifyIndicator, displayedVerifyState } from "./VerifyIndicator";

import { linkSetKey, tagSetKey, diffTagLists } from "../fieldChanges";
import { getTaskTypeColor } from "../../task-types";
import { transformImageForUpload } from "../imageTransform";
import { presenceAreaLabel, presenceChipFill, presenceInitials } from "./shared/presence";

const PASTE_HINT_KEY = "vibeflow-paste-hint-dismissed";

function PasteHintBanner({
  storageKey = PASTE_HINT_KEY,
}: {
  storageKey?: string;
}) {
  const [visible, setVisible] = React.useState(() => {
    try {
      return !localStorage.getItem(storageKey);
    } catch {
      return true;
    }
  });

  if (!visible) return null;

  function dismiss() {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      /* storage may be unavailable */
    }
    setVisible(false);
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        margin: "0 0 6px",
        borderRadius: 6,
        background: "rgba(37,99,235,0.08)",
        border: "1px solid rgba(37,99,235,0.18)",
        fontSize: 11,
        color: "var(--t-accent-soft)",
        flexShrink: 0,
      }}
    >
      <span style={{ flex: 1, lineHeight: 1.4 }}>
        💡 <strong>Tip:</strong> Paste screenshots or files anywhere in this
        panel — they attach automatically.
      </span>
      <button
        onClick={dismiss}
        title="Dismiss"
        style={{
          flexShrink: 0,
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 2,
          color: "var(--t-accent-soft)",
          opacity: 0.7,
          display: "flex",
          alignItems: "center",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = "1";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = "0.7";
        }}
      >
        <X style={{ width: 12, height: 12 }} />
      </button>
    </div>
  );
}

type Tab = "details" | "comments" | "files";

const STATUS_BUTTONS: { id: TaskStatus; label: string }[] = [
  { id: "backlog", label: "backlog" },
  { id: "todo", label: "todo" },
  { id: "in-progress", label: "in-progress" },
  { id: "review", label: "review" },
  { id: "done", label: "done" },
];

const PRESENCE_MAX_CHIPS = 4;

/**
 * Compact co-presence stack inlined with the status row (bc908cca).
 *
 * One 20px initials chip per peer (avatar-stack pattern): the full
 * "<user> is in <area>" sentence lives in each chip's title (hover) and
 * aria-label (screen reader); chips are keyboard-focusable. Crowds
 * collapse to a "+N" chip whose title/aria names everyone hidden, so the
 * status row never grows with the peer count. Chip hue mirrors the
 * peer's description-cursor hue (same person, same hue); the fill is the
 * high-contrast `presenceChipFill` variant (f84e68bd) so white initials
 * clear 4.5:1 on every hue.
 *
 * Right-aligned (f84e68bd): the stack renders AFTER the verify row and
 * consumes the free space via `marginLeft: auto` when no verify row is
 * shown, so the line always hugs the row's right edge.
 */
function PresenceStack({
  presence,
  pushRight,
}: {
  presence: PresenceEntry[];
  /** No verify row to the left — this stack owns the free space. */
  pushRight?: boolean;
}) {
  if (presence.length === 0) return null;
  const sentence = (p: PresenceEntry) =>
    p.area ? `${p.user} is in ${presenceAreaLabel(p.area)}` : `${p.user} is here`;
  const visible = presence.slice(0, PRESENCE_MAX_CHIPS);
  const hidden = presence.slice(PRESENCE_MAX_CHIPS);
  const chipStyle = (color: string, overlap: boolean): React.CSSProperties => ({
    width: 20,
    height: 20,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 9,
    fontWeight: 700,
    lineHeight: 1,
    color: "#fff",
    textShadow: "0 1px 2px rgba(0,0,0,0.55)",
    backgroundColor: color,
    boxShadow: "0 0 0 2px var(--t-surface)",
    marginLeft: overlap ? -6 : 0,
    cursor: "default",
    outline: "none",
    flexShrink: 0,
  });
  return (
    <div
      data-testid="presence-line"
      role="group"
      aria-label={`Also in this task: ${presence.map(sentence).join("; ")}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        rowGap: 4,
        minWidth: 0,
        marginLeft: pushRight ? "auto" : 4,
      }}
    >
      {visible.map((p, i) => {
        const label = sentence(p);
        return (
          <span
            key={p.userId ?? p.user}
            className="presence-chip"
            data-presence-user={p.user}
            tabIndex={0}
            title={label}
            aria-label={label}
            style={chipStyle(presenceChipFill(p.userId), i > 0)}
          >
            {presenceInitials(p.user)}
          </span>
        );
      })}
      {hidden.length > 0 && (
        <span
          className="presence-chip"
          tabIndex={0}
          title={`Also here: ${hidden.map(sentence).join("; ")}`}
          aria-label={`Also here: ${hidden.map(sentence).join("; ")}`}
          style={chipStyle("hsl(220, 9%, 45%)", true)}
        >
          +{hidden.length}
        </span>
      )}
    </div>
  );
}

interface Props {
  open: boolean;
  task: Task | null;
  tab: Tab;
  addColumnId?: TaskStatus;
  gitUserName?: string;
  githubUrl?: string | null;
  baseUrl: string;
  isResizing?: boolean;
  /** When true the panel renders its fullscreen restore affordance. Defaults to false. */
  fullscreen?: boolean;
  /** Toggles the persisted fullscreen preference. Never closes the panel. */
  onToggleFullscreen?: () => void;
  api: KanbanApi;
  onClose: () => void;
  onCreate: (draft: Partial<Task>) => Promise<string | undefined>;
  onDelete: (taskId: string) => void;
  onPatch: (taskId: string, patch: Partial<Task>) => void;
  onFilePreview: (name: string, url: string) => void;
  onActivityChange?: (
    taskId: string | null,
    state: "viewing" | "editing",
    area?: PresenceArea | null,
  ) => void;
  /** Peers currently in the open task — compact avatar stack in the status row. */
  presence?: PresenceEntry[];
  /**
   * Live binding to the shared description doc. While present (and not
   * adding), the doc is the single writer: the editor shows `text`, every
   * keystroke routes into the doc, and the whole-value description save is
   * retired (title still saves through `onPatch`). Remote cursors render in
   * the description only.
   */
  descriptionDoc?: DescriptionDocBinding | null;
  /** All tasks on the board — used to build the global tag pool for autocomplete. */
  allTasks?: Task[];
  /** Called when the user clicks the back button. Shown only when defined. */
  onGoBack?: () => void;
  /** Navigate to a different task in the detail panel (e.g., click a child). */
  onOpenTask?: (task: Task) => void;
  externalLocalChanges?: LocalChange[];
  /** Label shown in the back button tooltip (the previous task title). */
  navBackLabel?: string;
  /** Monotonically increasing counter that triggers a comment/badge refetch when bumped. */
  commentVersion?: number;
  /** Same as commentVersion but for files: bump to refetch the file list without a reload. */
  fileVersion?: number;
  /** When true, enforce branch name input when setting status to review. */
  createBranch?: boolean;
  /** Sibling reorder inside one parent (detail-panel tree drops). */
  onTreeReorder?: (
    draggedId: string,
    targetId: string,
    position: "before" | "after",
    parentId: string,
  ) => void;
  /** Move under a different parent (detail-panel tree drops). */
  onTreeReparent?: (
    draggedId: string,
    newParentId: string,
    targetId?: string,
    position?: "before" | "after",
  ) => void;
  /** Called when the user confirms unlink (removes parent link, never deletes). */
  onDetach?: (taskId: string) => void;
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB — must match server limit

export function DetailPanel({
  open,
  task,
  tab,
  addColumnId = "todo",
  gitUserName = "You",
  githubUrl,
  baseUrl,
  isResizing,
  fullscreen = false,
  onToggleFullscreen,
  api,
  onClose,
  onCreate,
  onDelete,
  onPatch,
  onFilePreview,
  onActivityChange,
  externalLocalChanges = [],
  presence = [],
  onGoBack,
  onOpenTask,
  navBackLabel,
  commentVersion,
  fileVersion,
  allTasks = [],
  createBranch,
  onTreeReorder,
  onTreeReparent,
  onDetach,
  descriptionDoc,
}: Props) {
  const isAdd = !task;
  // While a doc is live the collaborative doc is the single writer of the
  // description (see `descValue`/`handleDescChange` below): the whole-value
  // description patch is retired. Title and the other fields still save.
  const docLive = !isAdd && !!descriptionDoc;
  const _typeColor = task
    ? getTaskTypeColor(task.type)
    : getTaskTypeColor("Task");
  const panelRef = React.useRef<HTMLElement>(null);
  const [pendingPasteFiles, setPendingPasteFiles] = React.useState<File[]>([]);
  const isResizingRef = React.useRef(false);
  const originalTitleRef = React.useRef("");
  const originalDescRef = React.useRef("");
  // 3647a471: set when THIS session types into the live description doc.
  // Peer edits arriving through the doc never set it, so the blur-save
  // below can tell our own edit (one activity entry) from adopting
  // remote text (no entry) apart.
  const docDirtyRef = React.useRef(false);

  // Compute global tag pool from all tasks (stable reference)
  const allTags = React.useMemo(() => {
    const set = new Set<string>();
    for (const t of allTasks) for (const tag of t.tags ?? []) set.add(tag);
    return [...set].sort();
  }, [allTasks]);

  // `#` mention index + hover-card lookup for the markdown editors and
  // previews below. Threading the in-memory task list here (instead of the
  // editors' legacy `GET /api/tasks*` fetches) is what keeps the detail
  // pane request-clean on hosts without the CLI-board API (ticket d4c533f9:
  // the web app has no `/api/tasks` route, so every mount 404'd).
  const mentionTasks = React.useMemo(
    () =>
      (allTasks ?? [])
        .filter((t) => t?.id)
        .map((t) => ({ id: t.id, title: t.title ?? "" })),
    [allTasks],
  );
  const taskLookup = React.useCallback(
    (id: string) => {
      const hit = (allTasks ?? []).find((t) => t?.id === id);
      return hit
        ? { title: hit.title ?? `Task ${id}`, status: hit.status ?? "unknown" }
        : undefined;
    },
    [allTasks],
  );

  // Local form state
  const [activeTab, setActiveTab] = React.useState<Tab>(tab);
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  // Live-doc display value and change router: bypass the local `description`
  // state entirely while the doc is the single writer.
  const descValue = docLive ? (descriptionDoc?.text ?? "") : description;
  const handleDescChange = React.useCallback(
    (next: string) => {
      if (descriptionDoc) {
        descriptionDoc.onEdit(next);
        docDirtyRef.current = true;
      } else setDescription(next);
    },
    [descriptionDoc],
  );
  const [status, setStatus] = React.useState<TaskStatus>(addColumnId);
  const [type, setType] = React.useState<TaskType>("Task");
  const [priority, setPriority] = React.useState<Priority | "">("");
  const [showDescPreview, setShowDescPreview] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [showCommentSendConfirm, setShowCommentSendConfirm] =
    React.useState(false);
  const [branchName, setBranchName] = React.useState("");
  const [showBranchPrompt, setShowBranchPrompt] = React.useState(false);
  const pendingReviewPatchRef = React.useRef<{
    taskId: string;
    patch: Partial<Task>;
  } | null>(null);

  // Tab data
  const [comments, setComments] = React.useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = React.useState(false);
  const [commentsError, setCommentsError] = React.useState<string | null>(null);
  const [commentInput, setCommentInput] = React.useState("");
  const [commentSubmitting, setCommentSubmitting] = React.useState(false);

  const [files, setFiles] = React.useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = React.useState(false);
  const [filesError, setFilesError] = React.useState<string | null>(null);
  /**
   * True once the files list has been successfully fetched for the open
   * task (reset with `files` in the open effect below). While false the
   * details screenshot falls back to the board snapshot's `task.files`;
   * once true the fetched list is authoritative EVEN WHEN EMPTY — an empty
   * fetch means the file is gone, and falling back to the possibly-stale
   * snapshot would keep requesting the removed file's image (404, ticket
   * 17d42681). The error path leaves this untouched so a failed fetch keeps
   * today's fallback instead of hiding a screenshot that may still exist.
   */
  const [filesLoaded, setFilesLoaded] = React.useState(false);

  const [commentCount, setCommentCount] = React.useState(0);
  const commentsLoadGen = React.useRef(0);
  const [fileCount, setFileCount] = React.useState(0);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  /**
   * Files currently moving through paste → transform → upload → reload.
   * An entry is added BEFORE the seconds-long wasm transform starts and removed
   * only after the stored file is listed (or the attempt fails), so the
   * pending tile in the Files pane is honest about the wait. While non-empty
   * no new attach submission is accepted (see `uploadBusyRef`) — duplicate
   * submissions stay disabled until the in-flight one settles. `image` is
   * MIME knowledge from the File/clipboard item, never a filename match.
   */
  const [uploading, setUploading] = React.useState<{ name: string; image: boolean }[]>([]);
  const uploadBusyRef = React.useRef(false);
  /** Create-task mode: a paste is being transformed before it can buffer. */
  const [bufferingPaste, setBufferingPaste] = React.useState(false);
  const [bufferError, setBufferError] = React.useState<string | null>(null);
  const [localChanges, setLocalChanges] = React.useState<LocalChange[]>([]);
  const [draftTags, setDraftTags] = React.useState<string[]>([]);
  const [_linksSaving, setLinksSaving] = React.useState(false);
  const [linksError, setLinksError] = React.useState<string | null>(null);
  // Over-limit description guard: maxLength on the editor makes this
  // unreachable by typing/pasting, but a merged live-doc or a stale client
  // can still attempt it — map the Zod too_big to a human sentence here
  // (the call site) instead of a bare BAD_REQUEST. Same box pattern as linksError.
  const [descError, setDescError] = React.useState<string | null>(null);
  const titleInputRef = React.useRef<HTMLInputElement>(null);
  const autoSaveRef = React.useRef<() => void>(() => {});
  const commentInputRef = React.useRef("");
  const showCommentSendConfirmRef = React.useRef(false);

  // Keep commentInputRef in sync so the outside-click handler can check it without closure staling.
  React.useEffect(() => {
    commentInputRef.current = commentInput;
  }, [commentInput]);
  React.useEffect(() => {
    showCommentSendConfirmRef.current = showCommentSendConfirm;
  }, [showCommentSendConfirm]);

  // Keep resize ref in sync so the outside-click handler always reads current value
  // without being in the effect dependency array (avoids re-registering on each resize move).
  React.useEffect(() => {
    isResizingRef.current = isResizing ?? false;
  }, [isResizing]);

  // Area of the task this panel is currently showing. Presence is
  // per-task AND per-area: peers see which part each user is in.
  const tabArea = (t: Tab): PresenceArea =>
    t === "comments" ? "comments" : t === "files" ? "files" : "description";

  // Notify parent when panel closes (presence clears: not in any task)
  React.useEffect(() => {
    if (!open) {
      onActivityChange?.(null, "viewing", null);
    }
  }, [open]);

  // Detect dirty state and notify parent. Dirty means actively editing;
  // clean means viewing. Nothing here refuses an edit — presence is
  // informational, never a lock.
  React.useEffect(() => {
    if (!open || !task) return;
    const isDirty =
      title !== originalTitleRef.current ||
      description !== originalDescRef.current;
    if (isDirty) {
      onActivityChange?.(task.id, "editing", tabArea(activeTab));
    } else {
      onActivityChange?.(task.id, "viewing", tabArea(activeTab));
    }
  }, [title, description, open, task?.id, activeTab]);

  // Sync form when task/panel opens
  // Close panel when clicking outside (f831ac43)
  React.useEffect(() => {
    if (!open) return;
    function handleOutsideClick(e: MouseEvent) {
      if (isResizingRef.current) return;
      // Allow clicks on portaled autocomplete dropdowns (rendered outside the panel DOM).
      if ((e.target as Element)?.closest?.("[data-task-ref-suggest]")) return;
      // Allow clicks on the portaled type-picker menu (c94cde70): it renders
      // in document.body — outside the panel DOM — so it escapes the title
      // field's overflow clip. Without this, picking a type mousedowns
      // outside the panel and closes it mid-select.
      if ((e.target as Element)?.closest?.('[data-role="type-picker-menu"]')) return;
      // Allow clicks inside any modal overlay (FilePreviewModal, SettingsModal, etc.)
      // They render outside the panel DOM but should not close the panel.
      if ((e.target as Element)?.closest?.(".modal-backdrop")) return;
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
        // A mousedown on a task card is NOT an "outside click". Closing here collapses the
        // board's reserved right inset (boardRightInset), so every card reflows while the
        // button is still down: the panel disappears before the click lands and the card you
        // pressed can end up never opening it. The click that follows decides visibility via
        // openPanel, so save and leave the panel alone. A pending comment still raises its
        // confirm above, before this point.
        const pressedCard = (e.target as Element)?.closest?.("article.task-card");
        if (!pressedCard) onClose();
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open, onClose]);

  // Handle Escape key: check for pending comment before closing
  React.useEffect(() => {
    if (!open) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Don't interfere with Escape from inner text fields in the title (they handle Escape separately)
      // This listener handles the global Escape to close the panel
      if (showCommentSendConfirmRef.current) {
        setShowCommentSendConfirm(false);
        e.stopPropagation();
        return;
      }
      if (commentInputRef.current.trim().length > 0) {
        e.stopPropagation();
        autoSaveRef.current();
        setShowCommentSendConfirm(true);
        return;
      }
    }
    document.addEventListener("keydown", handleEsc, { capture: true });
    return () =>
      document.removeEventListener("keydown", handleEsc, { capture: true });
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    setActiveTab(tab);
    // Existing tasks open in preview mode; new tasks open in edit mode.
    setShowDescPreview(Boolean(task));
    setCommentInput("");
    setComments([]);
    setFiles([]);
    setFilesLoaded(false);
    setCommentCount(0);
    setFileCount(0);
    setLocalChanges([]);
    setDraftTags([]);
    docDirtyRef.current = false;
    setBranchName(task?.branchName ?? "");
    setShowBranchPrompt(false);
    pendingReviewPatchRef.current = null;

    if (task) {
      // Trim stored values so autoSave comparisons are consistent (prevents
      // spurious patches when the DB title/description has trailing whitespace).
      const trimmedTitle = (task.title ?? "").trim();
      const trimmedDesc = (task.description ?? "").trim();
      setTitle(trimmedTitle);
      setDescription(trimmedDesc);
      setStatus(task.status);
      setType(task.type ?? "Task");
      setPriority(task.priority ?? "");
      originalTitleRef.current = trimmedTitle;
      originalDescRef.current = trimmedDesc;
      onActivityChange?.(task.id, "viewing", tabArea(tab));
    } else {
      setTitle("");
      setDescription("");
      setStatus(addColumnId);
      setType("Task");
      setPriority("");
    }

    if (task) {
      // One round: badge counts + the files list the details tab
      // previews (ticket d4c533f9) — the old badge+files double load
      // issued the files fetch twice for the same end state.
      void loadPanelData(task.id);
    }

    // Focus the title — but never by taking focus away from a control the user
    // (or the browser) has already put focus on.
    //
    // This used to be an unconditional `setTimeout(focus, 50)`, which fired on
    // EVERY [open, task?.id, tab] change. Two real bugs came out of that:
    //   1. Open a task, click the Tags input, and 50ms later focus jumped back
    //      to the title — mid-click, mid-typing.
    //   2. Anything that dispatches text into the focused element (a fast
    //      typist, an IME, an autofill, a test driver) had its characters
    //      delivered to the title instead, silently renaming the task. That one
    //      was reproducible ~1 run in 3 in the web e2e suite and corrupted real
    //      rows: "Tag Test Task" became "Tag Test Taskmy-new-tag".
    //
    // The panel autofocuses its own comment box on open, so "focus is inside
    // the panel" is not by itself evidence of a user claim — that one is
    // excluded by id, otherwise the title would never be focused at all.
    const focusTimer = setTimeout(() => {
      const input = titleInputRef.current;
      if (!input) return;
      const active = document.activeElement;
      const isPanelOwnDefaultFocus = active?.id === "dp-comment-input";
      if (
        active &&
        active !== document.body &&
        !isPanelOwnDefaultFocus &&
        panelRef.current?.contains(active)
      ) {
        return;
      }
      // preventScroll: the panel just opened beside the board — focusing
      // must not yank the page scroll (focus-scroll jank).
      input.focus({ preventScroll: true });
    }, 50);
    return () => clearTimeout(focusTimer);
  }, [open, task?.id, tab]);

  // Load content when switching tabs
  React.useEffect(() => {
    if (!open || !task) return;
    if (activeTab === "comments") {
      loadComments(task.id);
      loadFiles(task.id);
    } else if (activeTab === "files") loadFiles(task.id);
  }, [activeTab, open, task?.id]);

  // Sync form fields when the task prop changes externally (e.g., another user patched
  // the title/description) — but only if the local form has no unsaved changes.
  React.useEffect(() => {
    if (!open || !task) return;
    const localDirty =
      title !== originalTitleRef.current ||
      description !== originalDescRef.current;
    if (localDirty) return; // don't overwrite user's in-progress edits
    const trimmedTitle = (task.title ?? "").trim();
    const trimmedDesc = (task.description ?? "").trim();
    if (
      trimmedTitle !== originalTitleRef.current ||
      trimmedDesc !== originalDescRef.current
    ) {
      setTitle(trimmedTitle);
      setDescription(trimmedDesc);
      originalTitleRef.current = trimmedTitle;
      originalDescRef.current = trimmedDesc;
    }
    if (task.status && task.status !== status) setStatus(task.status);
    if (task.type && task.type !== type) setType(task.type);
    if (task.priority !== undefined && task.priority !== priority)
      setPriority(task.priority ?? "");
    const externalBranchName = task.branchName ?? "";
    if (externalBranchName !== branchName) setBranchName(externalBranchName);
  }, [
    task?.title,
    task?.description,
    task?.status,
    task?.type,
    task?.priority,
    task?.branchName,
  ]);

  // Refresh panel data when the host bumps a version counter (ticket
  // d4c533f9). Each changed part refetches exactly once: the visible list
  // when its tab is open, otherwise just its count — except files, whose
  // list ALSO feeds the details tab screenshot preview (dd380f25), so a
  // file bump always reloads the list, on any tab. A coalesced both-bump
  // is one comments fetch + one files fetch, never two full badge rounds.
  // The ref skips the first run: the open effect above already loaded.
  const prevVersionsRef = React.useRef<{
    comments?: number;
    files?: number;
  }>({});
  React.useEffect(() => {
    const prev = prevVersionsRef.current;
    prevVersionsRef.current = {
      comments: commentVersion,
      files: fileVersion,
    };
    if (!open || !task) return;
    if (commentVersion === undefined || fileVersion === undefined) return;
    if (prev.comments === undefined || prev.files === undefined) return;
    if (commentVersion !== prev.comments) {
      if (activeTab === "comments") void loadComments(task.id);
      else void refreshCommentCount(task.id);
    }
    if (fileVersion !== prev.files) {
      // Always the full list, not just the count: the details tab renders
      // its screenshot preview from `files`, so a count-only refresh would
      // leave the preview stale until the user opens the files tab. Same
      // request refreshFileCount used to make (getFiles), minus discarding.
      void loadFiles(task.id);
    }
  }, [commentVersion, fileVersion, activeTab, open, task?.id]);

  async function refreshCommentCount(taskId: string) {
    try {
      const data = await api.getComments(taskId);
      setCommentCount(data.comments?.length ?? 0);
    } catch {
      /* network error — count stays stale */
    }
  }


  /** One comments fetch + one files fetch for a freshly opened panel:
   * badge counts plus the files list — the same end state the old
   * badge+files double load produced, minus the duplicate files request. */
  async function loadPanelData(taskId: string) {
    try {
      const [cd, fd] = await Promise.all([
        api.getComments(taskId),
        api.getFiles(taskId),
      ]);
      setCommentCount(cd.comments?.length ?? 0);
      const next = fd.files ?? [];
      setFiles(next);
      setFilesLoaded(true);
      setFileCount(next.length);
    } catch {
      /* network error — counts stay at their reset zero, lists stay empty */
    }
  }

  async function loadBadgeCounts(taskId: string) {
    try {
      const [cd, fd] = await Promise.all([
        api.getComments(taskId),
        api.getFiles(taskId),
      ]);
      setCommentCount(cd.comments?.length ?? 0);
      setFileCount(fd.files?.length ?? 0);
    } catch {
      /* network error — badge counts stay stale */
    }
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
      setCommentsError("failed");
    } finally {
      if (commentsLoadGen.current === gen) setCommentsLoading(false);
    }
  }

  async function loadFiles(taskId: string): Promise<FileEntry[]> {
    setFilesLoading(true);
    setFilesError(null);
    try {
      const data = await api.getFiles(taskId);
      const next = data.files ?? [];
      setFiles(next);
      setFilesLoaded(true);
      setFileCount(next.length);
      return next;
    } catch {
      setFilesError("failed");
      return [];
    } finally {
      setFilesLoading(false);
    }
  }

  async function handleSave() {
    if (!title.trim()) {
      titleInputRef.current?.focus();
      return;
    }
    // Auto-submit pending comment when saving an existing task
    if (!isAdd && commentInput.trim()) {
      await handleSubmitComment();
    }
    if (isAdd) {
      const trimmedNewDesc = description.trim() || title.trim();
      if (trimmedNewDesc.length > TASK_DESCRIPTION_MAX) {
        setDescError(formatDescriptionTooLong(trimmedNewDesc.length));
        return;
      }
      setDescError(null);
      // Close first: the create round-trip must not hold the panel open.
      // The board already paints the optimistic card synchronously inside
      // onCreate, so awaiting here only left the panel sitting open with no
      // progress state while the card hid behind it (ticket 7fd3280b).
      const files = pendingPasteFiles;
      const created = onCreate({
        title: title.trim(),
        description: description.trim() || title.trim(),
        status,
        type,
        priority: priority || undefined,
        selector: "/",
        tags: draftTags.length > 0 ? draftTags : undefined,
      });
      setPendingPasteFiles([]);
      onClose();
      // Pasted files still need the real id — upload in the background
      // once the create resolves. A refused create yields no id, so the
      // files are dropped along with the retracted optimistic card.
      void created
        .then((newTaskId) => {
          if (!newTaskId || files.length === 0) return;
          for (const file of files) {
            void api.uploadFile(newTaskId, file).catch(() => null);
          }
        })
        .catch(() => null);
    } else {
      autoSave();
    }
  }

  // While a doc is live, peer text adopted without a local edit resets the
  // base silently: only our own keystrokes (docDirtyRef) earn an entry.
  React.useEffect(() => {
    if (!docLive || docDirtyRef.current || !task) return;
    const liveText = (descriptionDoc?.text ?? "").trim();
    if (liveText !== originalDescRef.current) {
      originalDescRef.current = liveText;
    }
  }, [docLive, task?.id, descriptionDoc?.text]);

  function autoSave() {
    if (!task || isAdd) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    const trimmedDesc = description.trim();
    if (trimmedDesc.length > TASK_DESCRIPTION_MAX) {
      setDescError(formatDescriptionTooLong(trimmedDesc.length));
      return;
    }
    setDescError(null);
    const prevTitle = originalTitleRef.current;
    const prevDesc = originalDescRef.current;
    const titleChanged = trimmedTitle !== prevTitle;
    // While a doc is live it is the single writer of the description: the
    // whole-value description patch is retired (the doc flushes itself
    // through the shared write). Title and the other fields still save.
    // 3647a471: our own doc edits still earn ONE activity entry per save
    // cycle (blur/close/outside-click) — the doc has no discrete save of
    // its own, so the save cycle is the entry boundary.
    const liveDesc = docLive ? (descriptionDoc?.text ?? "").trim() : null;
    const docDescChanged =
      docLive &&
      liveDesc !== null &&
      docDirtyRef.current &&
      liveDesc !== prevDesc;
    const descChanged = !docLive && description.trim() !== prevDesc;
    if (!titleChanged && !descChanged && !docDescChanged) return;
    if (titleChanged) {
      recordChange("title", prevTitle, trimmedTitle);
    }
    if (descChanged) {
      recordChange("description", prevDesc, description.trim());
    }
    if (docDescChanged && liveDesc !== null) {
      recordChange("description", prevDesc, liveDesc);
    }
    onPatch(task.id, {
      title: trimmedTitle,
      ...(descChanged ? { description: description.trim() } : {}),
      type,
      priority: priority || undefined,
    });
    originalTitleRef.current = trimmedTitle;
    if (descChanged && liveDesc === null) originalDescRef.current = description.trim();
    if (docDescChanged && liveDesc !== null) {
      originalDescRef.current = liveDesc;
      docDirtyRef.current = false;
    }
  }

  // Keep autoSaveRef always current so outside-click handler uses latest state
  autoSaveRef.current = autoSave;

  function recordChange(
    field: string,
    from: string,
    to: string,
    tagDiff?: { added: string[]; removed: string[] },
  ) {
    if (from === to) return;
    setLocalChanges((prev) => [
      ...prev,
      {
        field,
        from,
        to,
        // 59f91dc0: tags name the actual added/removed tags — recorded
        // here from the real arrays (comma-safe), not parsed in the UI.
        ...(tagDiff ? { added: tagDiff.added, removed: tagDiff.removed } : {}),
        actor: gitUserName,
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  // Optimistic append (fa0d3d0e): the new row renders instantly with the
  // feed's enter animation while the mutation is in flight — old entries
  // stay visible at all times (CommentsList keeps saved rows during
  // refetches) and the server list reconciles the provisional id below.
  // A failed send drops the provisional row and reloads the saved list.
  async function handleSubmitComment() {
    if (!task || !commentInput.trim()) return;
    const body = commentInput.trim();
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: Comment = {
      id: tempId,
      author: gitUserName,
      text: body,
      createdAt: new Date().toISOString(),
      isOwnComment: true,
    };
    setCommentInput("");
    setComments((prev) => [...prev, optimistic]);
    setCommentCount((n) => n + 1);
    setCommentSubmitting(true);
    try {
      await api.addComment(task.id, body);
      await loadComments(task.id);
    } catch {
      setComments((prev) => prev.filter((c) => c.id !== tempId));
      await loadComments(task.id).catch(() => null);
    } finally {
      setCommentSubmitting(false);
    }
  }

  // Optimistic edit: the saved text stays on screen with the new text
  // applied in place — never a blank feed — and the refetch reconciles.
  // A failed edit reloads the server text (the in-place draft in
  // CommentsList editing state is untouched by the list swap).
  async function handleEditComment(comment: Comment, newText: string) {
    if (!task) return;
    setComments((prev) =>
      prev.map((c) => (c.id === comment.id ? { ...c, text: newText } : c)),
    );
    try {
      await api.updateComment(task.id, comment.id, newText);
    } finally {
      await loadComments(task.id).catch(() => null);
    }
  }

  // Optimistic delete: the row leaves at once; a failed delete reloads the
  // server list, which restores the row instead of dropping it silently.
  async function handleDeleteComment(comment: Comment) {
    if (!task) return;
    setComments((prev) => prev.filter((c) => c.id !== comment.id));
    setCommentCount((n) => Math.max(0, n - 1));
    try {
      await api.deleteComment(task.id, comment.id);
    } finally {
      await loadComments(task.id).catch(() => null);
    }
  }

  /**
   * One attach submission (a paste or one file-picker batch): every job gets a
   * pending tile the moment the submission starts, each tile clears only when
   * its stored file is listed, and any failure — transform, upload rejection,
   * or an upload that resolves without the file appearing — lands in the
   * visible upload-error box instead of failing silently. While a batch is in
   * flight (`uploadBusyRef`) new submissions are refused so duplicates cannot
   * stack up behind a slow transform; the visible pending tile says why.
   */
  async function runUploadBatch(
    taskId: string,
    jobs: { name: string; image: boolean; produce: () => Promise<File> }[],
  ): Promise<void> {
    if (jobs.length === 0 || uploadBusyRef.current) return;
    uploadBusyRef.current = true;
    setUploadError(null);
    setUploading((prev) => [
      ...prev,
      ...jobs
        .filter((j) => !prev.some((p) => p.name === j.name))
        .map((j) => ({ name: j.name, image: j.image })),
    ]);
    const failures: string[] = [];
    try {
      for (const job of jobs) {
        try {
          const stored = await job.produce();
          const next = await loadFiles(taskId);
          if (!next.some((f) => f.name === stored.name)) {
            failures.push(`"${job.name}" uploaded but is not listed`);
          }
        } catch (err) {
          failures.push(
            `"${job.name}": ${err instanceof Error ? err.message : "upload failed"}`,
          );
        } finally {
          setUploading((prev) => prev.filter((p) => p.name !== job.name));
        }
      }
      if (failures.length > 0) {
        setUploadError(`Couldn't attach ${failures.join("; ")}.`);
      } else {
        void loadBadgeCounts(taskId);
      }
    } finally {
      uploadBusyRef.current = false;
    }
  }

  /** Paste-style display name that cannot collide with an in-flight upload. */
  function nextPasteName(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = `paste-${ts}`;
    let name = `${base}.png`;
    for (let n = 2; uploading.some((u) => u.name === name); n++) name = `${base}-${n}.png`;
    return name;
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!task) return;
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) return;
    const taskId = task.id;
    await runUploadBatch(
      taskId,
      picked.map((file) => ({
        name: file.name,
        image: file.type.startsWith("image/"),
        produce: async () => {
          if (!file.type.startsWith("image/") && file.size > MAX_UPLOAD_BYTES) {
            throw new Error("exceeds the 5 MB limit and was skipped");
          }
          let toUpload: File;
          if (file.type.startsWith("image/")) {
            // Shared ingest matrix: PNG→lossless WebP, >1920→1920+q80 WebP,
            // JPEG kept (+metadata strip), GIF/SVG untouched. True extension.
            ({ file: toUpload } = await transformImageForUpload(file, file.name));
          } else {
            toUpload = file;
          }
          await api.uploadFile(taskId, toUpload);
          return toUpload;
        },
      })),
    );
  }

  async function uploadPastedImage(blob: Blob) {
    if (!task) return;
    const taskId = task.id;
    const name = nextPasteName();
    await runUploadBatch(taskId, [
      {
        name,
        image: true,
        produce: async () => {
          const { file } = await transformImageForUpload(blob, name);
          await api.uploadFile(taskId, file);
          return file;
        },
      },
    ]);
  }

  // Centralized paste handler — handles images, files, and file-system paths
  // Uses a document-level listener (not onPaste) so paste works even when no editable element is focused
  async function handleClipboardPaste(clipboardData: DataTransfer) {
    if (!task || uploadBusyRef.current) return;
    const taskId = task.id;
    const items = Array.from(clipboardData.items);

    // Images get their own named file (paste-<timestamp>.png)
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (imageItem) {
      const blob = imageItem.getAsFile();
      if (blob) await uploadPastedImage(blob);
      return;
    }

    // Any other pasted files (e.g. text/csv, application/pdf, …) are uploaded as-is
    const pasted = items
      .filter((item) => item.kind === "file" && !item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (pasted.length > 0) {
      await runUploadBatch(
        taskId,
        pasted.map((file) => ({
          name: file.name,
          image: false,
          produce: async () => {
            await api.uploadFile(taskId, file);
            return file;
          },
        })),
      );
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
      const isTextInput =
        target.tagName === "TEXTAREA" ||
        target.tagName === "INPUT" ||
        target.isContentEditable;
      if (isTextInput) {
        // Still intercept images/files even in text fields (they can't accept those anyway)
        const items = Array.from(e.clipboardData.items);
        const hasImageOrFile = items.some((it) => it.kind === "file");
        if (!hasImageOrFile) return;
      }
      e.preventDefault();
      // In "create task" mode: buffer pasted files for upload after task creation
      if (!task) {
        const items = Array.from(e.clipboardData.items);
        const imageItem = items.find((it) => it.type.startsWith("image/"));
        if (imageItem) {
          const blob = imageItem.getAsFile();
          if (blob) {
            // Visible immediately: the transform takes seconds and previously
            // showed nothing until the buffer note appeared. Failures surface
            // in the footer instead of rejecting silently.
            setBufferError(null);
            setBufferingPaste(true);
            void (async () => {
              try {
                const ts = new Date()
                  .toISOString()
                  .replace(/[:.]/g, "-")
                  .slice(0, 19);
                const { file } = await transformImageForUpload(
                  blob,
                  `paste-${ts}.png`,
                );
                setPendingPasteFiles((prev) => [...prev, file]);
              } catch (err) {
                setBufferError(
                  `Couldn't process pasted image: ${err instanceof Error ? err.message : "unknown error"}`,
                );
              } finally {
                setBufferingPaste(false);
              }
            })();
          }
        }
        return;
      }
      void handleClipboardPaste(e.clipboardData);
    }
    document.addEventListener("paste", onDocPaste);
    return () => document.removeEventListener("paste", onDocPaste);
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
    // Dismiss any pending branch prompt when clicking a non-review status
    if (showBranchPrompt && s !== "review") {
      setShowBranchPrompt(false);
      pendingReviewPatchRef.current = null;
    }

    setStatus(s);
    if (isAdd) {
      return;
    }
    if (!task) {
      return;
    }

    // When createBranch is ON and setting status to review, enforce branch name
    if (createBranch && s === "review" && !branchName.trim()) {
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
    const patch: Partial<Task> = {
      ...pendingReviewPatchRef.current.patch,
      branchName: branchName.trim(),
    };
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
    if (s !== status) return "dp-status-btn";
    return `dp-status-btn active-${s}`;
  };

  // Verification verdict for the header row — read through displayedVerifyState,
  // the SAME single gate the card and child rows use (no lane logic here).
  const verifyState = task ? displayedVerifyState(task) : "none";

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

  const mergedLocalChanges = React.useMemo(() => {
    const changes = [...externalLocalChanges, ...localChanges].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const deduped: LocalChange[] = [];
    for (const change of changes) {
      const duplicate = deduped.some(
        (existing) =>
          existing.field === change.field &&
          existing.from.toLowerCase() === change.from.toLowerCase() &&
          existing.to.toLowerCase() === change.to.toLowerCase() &&
          existing.actor === change.actor &&
          Math.abs(
            new Date(existing.timestamp).getTime() -
              new Date(change.timestamp).getTime(),
          ) <= 3000,
      );
      if (!duplicate) deduped.push(change);
    }
    return deduped;
  }, [externalLocalChanges, localChanges]);

  // Presence avatars: who else is in this task and in which area.
  // Informational only — it never disables anything. Rendered as a compact
  // initials stack inlined with the status row (bc908cca): the full
  // "<user> is in <area>" sentence lives in each chip's title/aria-label
  // (hover or keyboard focus reveals it), so a crowd of peers never
  // stretches the line. Areas render through presenceAreaLabel so the copy
  // agrees with the Activity tab; the raw area stays internal.
  // Full presence sentence per peer for chip title/aria-label.

  // `data-role` mirrors the id so specs can address the panel the same way
  // they address every other region of the board.
  //
  // This note sits ABOVE the return on purpose. It was previously the first two
  // children of the fragment below, where `//` is not a comment at all — JSX
  // treats it as literal text, so the panel rendered it as visible copy above
  // the header (vibeflow task fb876c20). Use {/* */} for notes that must live
  // inside JSX.
  return (
    <>
      <aside
        id="detail-panel"
        data-role="detail-panel"
        className="open"
        ref={panelRef}
        data-fullscreen={fullscreen ? "true" : "false"}
      >
        {/* Header */}
        <div className="dp-header">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 10,
            }}
          >
            {onGoBack && (
              <button
                id="dp-back"
                onClick={onGoBack}
                title={navBackLabel ? `Back to: ${navBackLabel}` : "Go back"}
                style={{
                  width: 26,
                  height: 26,
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 6,
                  border: "1px solid var(--t-border-faint)",
                  background: "transparent",
                  color: "var(--t-text-body)",
                  cursor: "pointer",
                  transition: "background .12s,color .12s",
                  fontSize: 14,
                  lineHeight: 1,
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.background = "var(--t-border)";
                  e.currentTarget.style.color = "var(--t-accent-soft)";
                  e.currentTarget.style.borderColor = "var(--t-accent)";
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--t-text-body)";
                  e.currentTarget.style.borderColor = "var(--t-border-faint)";
                }}
              >
                ←
              </button>
            )}
            {/* Title field (c94cde70): the type picker is an inline
                leading segment INSIDE the title input's bounds — one
                shared border/background — so it reads as part of the
                title field, not a detached widget. The title text stays
                the primary element (flex: 1). #dp-type-picker keeps its
                id and remains a labelled button opening the picker. */}
            <div className="dp-title-field" data-role="title-field">
            <TypePicker
              id="dp-type-picker"
              bare
              value={type}
              onChange={(newType) => {
                if (!isAdd && task && newType !== type)
                  recordChange("type", type, newType);
                setType(newType);
                if (!isAdd && task) onPatch(task.id, { type: newType });
              }}
            />
            <input
              id="dp-title"
              ref={titleInputRef}
              className="dp-input"
              type="text"
              placeholder="Task title…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  handleCloseRequest();
                }
                if (e.key === "Enter" && isAdd) void handleSave();
              }}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 14,
                fontWeight: 600,
                padding: "4px 8px",
                border: "none",
                background: "transparent",
                outline: "none",
                boxShadow: "none",
              }}
              onBlur={() => {
                if (!isAdd) autoSave();
              }}
            />
            </div>
            {!isAdd &&
              title !== originalTitleRef.current &&
              title.trim() !== "" && (
                <button
                  type="button"
                  title="Discard title changes"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setTitle(originalTitleRef.current);
                  }}
                  style={{
                    width: 20,
                    height: 20,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 4,
                    border: "1px solid var(--t-border-faint)",
                    background: "none",
                    color: "var(--t-text-body)",
                    cursor: "pointer",
                    fontSize: 13,
                    lineHeight: 1,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--t-warning-subtle)";
                    e.currentTarget.style.borderColor = "var(--t-warning-subtle)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--t-text-body)";
                    e.currentTarget.style.borderColor = "var(--t-border-faint)";
                  }}
                >
                  ↩
                </button>
              )}
            <button
              id="dp-fullscreen-toggle"
              onClick={onToggleFullscreen}
              aria-pressed={fullscreen}
              title={fullscreen ? "Restore panel" : "Expand to fullscreen"}
              style={{
                width: 26,
                height: 26,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                border: "none",
                background: "transparent",
                color: "var(--t-text-body)",
                cursor: "pointer",
                transition: "background .12s,color .12s",
                pointerEvents: "auto",
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.background = "var(--t-border)";
                e.currentTarget.style.color = "var(--t-text-muted)";
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--t-text-body)";
              }}
            >
              {fullscreen ? (
                <Minimize2 style={{ width: 14, height: 14 }} />
              ) : (
                <Maximize2 style={{ width: 14, height: 14 }} />
              )}
            </button>
            <button
              id="dp-close"
              onClick={handleCloseRequest}
              style={{
                width: 26,
                height: 26,
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                border: "none",
                background: "transparent",
                color: "var(--t-text-body)",
                cursor: "pointer",
                transition: "background .12s,color .12s",
                pointerEvents: "auto",
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.background = "var(--t-border)";
                e.currentTarget.style.color = "var(--t-text-muted)";
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--t-text-body)";
              }}
            >
              <X style={{ width: 14, height: 14 }} />
            </button>
          </div>

          {/* Status buttons */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: "var(--t-text-body)",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Status
            </span>
            {STATUS_BUTTONS.map((s) => (
              <button
                key={s.id}
                className={activeStatusClass(s.id)}
                data-status={s.id}
                onClick={() => handleStatusClick(s.id)}
              >
                {s.label}
              </button>
            ))}
            {/* Verification verdict — a quiet trailing note in the status
                cluster so it reads as one unit; the VerifyIndicator carries
                the tooltip (what the verdict means). */}
            {!isAdd && task && verifyState !== "none" && (
              <div
                id="dp-verify-row"
                data-verify-state={verifyState}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  // Right-align: this flex item consumes the free space
                  // left of it so the cluster hugs the row's right edge
                  // while staying in the same status-chip flex parent.
                  marginLeft: "auto",
                }}
              >
                <VerifyIndicator state={verifyState} />
                <span
                  style={{
                    fontSize: 11,
                    color:
                      verifyState === "verified"
                        ? "var(--t-text-muted)"
                        : "var(--t-warning)",
                  }}
                >
                  {verifyState === "verified"
                    ? "Verified"
                    : "Verification failed"}
                </span>
              </div>
            )}
            {/* Co-presence avatars (bc908cca), right-aligned (f84e68bd):
                after the verify row so the line always hugs the row's
                right edge. When no verify row is shown the stack owns the
                free space itself (pushRight); otherwise the verify row's
                auto margin already pushes the cluster right. */}
            <PresenceStack
              presence={presence}
              pushRight={isAdd || !task || verifyState === "none"}
            />
          </div>

          {/* Branch name prompt when createBranch is ON and setting to review */}
          {showBranchPrompt && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 8,
                padding: "8px 10px",
                borderRadius: 8,
                background: "rgba(139,92,246,0.08)",
                border: "1px solid rgba(139,92,246,0.2)",
                fontSize: 12,
              }}
            >
              <span
                style={{
                  color: "var(--t-chip-purple-300)",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                Branch name:
              </span>
              <input
                id="dp-branch-name"
                type="text"
                placeholder="e.g. feat/add-hover-effect"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && branchName.trim())
                    handleApplyBranchAndReview();
                  if (e.key === "Escape") handleCancelBranchPrompt();
                }}
                autoFocus
                style={{
                  flex: 1,
                  fontSize: 12,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--t-border)",
                  background: "var(--t-input)",
                  color: "var(--t-text)",
                  fontFamily: "monospace",
                }}
              />
              <button
                onClick={handleApplyBranchAndReview}
                disabled={!branchName.trim()}
                style={{
                  padding: "4px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--t-secondary)",
                  background: branchName.trim()
                    ? "var(--t-secondary)"
                    : "var(--t-border)",
                  color: "var(--t-white)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: branchName.trim() ? "pointer" : "not-allowed",
                  transition: "background .12s",
                }}
              >
                Apply & Review
              </button>
              <button
                onClick={handleCancelBranchPrompt}
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--t-border)",
                  background: "transparent",
                  color: "var(--t-text-body)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {/* Tabs (hidden in add mode) */}
        {!isAdd && (
          <div className="dp-tabs" id="dp-tabs-row">
            <button
              className={`dp-tab${activeTab === "details" ? " active" : ""}`}
              id="dp-tab-details"
              onClick={() => setActiveTab("details")}
            >
              Details
            </button>
            <button
              className={`dp-tab${activeTab === "comments" ? " active" : ""}`}
              id="dp-tab-activity"
              onClick={() => setActiveTab("comments")}
            >
              Activity{" "}
              {commentCount > 0 && (
                <span
                  id="dp-activity-count"
                  style={{ color: "var(--t-text-body)", fontSize: 10 }}
                >
                  ({commentCount})
                </span>
              )}
            </button>
            <button
              className={`dp-tab${activeTab === "files" ? " active" : ""}`}
              id="dp-tab-files"
              onClick={() => setActiveTab("files")}
            >
              Files{" "}
              {fileCount > 0 && (
                <span
                  id="dp-file-count"
                  style={{ color: "var(--t-text-body)", fontSize: 10 }}
                >
                  ({fileCount})
                </span>
              )}
            </button>
          </div>
        )}

        {/* Body */}
        <div className="dp-body">
          {!isAdd && <PasteHintBanner />}
          {/* ── Details pane ── */}
          <div
            className="dp-pane"
            id="dp-details-pane"
            style={{ display: !task || activeTab === "details" ? "" : "none" }}
          >
            <div style={{ flexShrink: 0 }}>
              <TaskDetailsTab
                task={task}
                description={descValue}
                setDescription={handleDescChange}
                showDescPreview={showDescPreview}
                setShowDescPreview={setShowDescPreview}
                priority={priority}
                setPriority={setPriority}
                onDescriptionBlur={isAdd ? undefined : autoSave}
                remoteSelections={docLive ? (descriptionDoc?.selections ?? []) : undefined}
                onDescriptionSelection={docLive ? descriptionDoc?.onSelection : undefined}
                onDescriptionDiscard={
                  isAdd || docLive
                    ? undefined
                    : () => {
                        setDescription(originalDescRef.current);
                        setShowDescPreview(true);
                      }
                }
                originalDescription={
                  isAdd ? undefined : originalDescRef.current
                }
                onPriorityChange={
                  isAdd
                    ? undefined
                    : (p) => {
                        if (task) {
                          if (p !== priority)
                            recordChange("priority", priority || "—", p || "—");
                          onPatch(task.id, { priority: p || undefined });
                        }
                      }
                }
                githubUrl={githubUrl}
                onFilePreview={onFilePreview}
                onDeleteScreenshot={handleDeleteScreenshot}
                onPatch={onPatch}
                liveFiles={filesLoaded || filesLoading ? files : undefined}
                allTags={allTags}
                overrideTags={isAdd ? draftTags : undefined}
                onTagsChange={
                  isAdd
                    ? setDraftTags
                      : (newTags) => {
                        // 3647a471: tags earn a minimal entry like every
                        // other details field. 59f91dc0: the entry names the
                        // actual added/removed tags, recorded here from the
                        // real arrays (comma-safe).
                        if (!task) return;
                        const beforeKey = tagSetKey(task.tags);
                        const afterKey = tagSetKey(newTags);
                        if (afterKey !== beforeKey) {
                          recordChange(
                            "tags",
                            beforeKey,
                            afterKey,
                            diffTagLists(task.tags, newTags),
                          );
                        }
                        onPatch(task.id, { tags: newTags });
                      }
                }
                isAdd={isAdd}
                mentionTasks={mentionTasks}
                taskLookup={taskLookup}
              />
              {descError && (
                <div
                  className="desc-error"
                  style={{
                    fontSize: 11,
                    color: "var(--t-danger)",
                    marginTop: 4,
                  }}
                >
                  {descError}
                </div>
              )}
            </div>
            {!isAdd && task && (
              // Ticket 6aa28fd6: the relations section now sits directly
              // below the tiles and keeps its own top divider, so it owns
              // the tiles→relations boundary. The meta chip row moved to
              // the very bottom of the pane (below); its wrapper carries
              // its top divider with it, so each live boundary still draws
              // exactly one rule (see 796f13e5 ownership invariant).
              <div
                style={{ marginTop: 8 }}
                onFocusCapture={() =>
                  onActivityChange?.(task.id, "viewing", "relations")
                }
                onBlurCapture={(e) => {
                  // Focus moving inside relations keeps the area; focus
                  // leaving it falls back to the tab area.
                  if (
                    e.currentTarget.contains(e.relatedTarget as Node | null)
                  )
                    return;
                  onActivityChange?.(
                    task.id,
                    "viewing",
                    tabArea(activeTab),
                  );
                }}
              >
                <RelationsSection
                  task={task}
                  allTasks={allTasks}
                  onOpenTask={onOpenTask}
                  onTreeReorder={onTreeReorder}
                  onTreeReparent={onTreeReparent}
                  onDetach={onDetach}
                  onUpdateLinks={async (links) => {
                    if (!task) return;
                    setLinksSaving(true);
                    setLinksError(null);
                    // 3647a471: relations earn a minimal entry like every
                    // other details field (recorded before the patch so a
                    // failed save still shows intent; the refetch reconciles).
                    const beforeKey = linkSetKey(task.links);
                    const afterKey = linkSetKey(links ?? []);
                    if (afterKey !== beforeKey) {
                      recordChange("relations", beforeKey, afterKey);
                    }
                    try {
                      await onPatch(task.id, {
                        links: links ?? [],
                      });
                    } catch (err: unknown) {
                      const msg =
                        err instanceof Error ? err.message : String(err);
                      setLinksError(msg);
                    } finally {
                      setLinksSaving(false);
                    }
                  }}
                />
                {linksError && (
                  <div
                    className="relations-error"
                    style={{
                      fontSize: 11,
                      color: "var(--t-danger)",
                      marginTop: 4,
                    }}
                  >
                    {linksError}
                  </div>
                )}
              </div>
            )}
            {!isAdd && task && buildDpMetaItems(task).length > 0 && (
              // Ticket 6aa28fd6: meta chip row moved to the very bottom
              // of the details pane. This wrapper keeps ownership of its
              // top divider, which now draws the relations→chip-row
              // boundary. It renders only when the chip row has content
              // (796f13e5 invariant: an empty wrapper would sandwich two
              // rules around nothing; dropping the rule would leave zero).
              // The relations section above keeps its own top divider for
              // the tiles→relations boundary — exactly one rule per live
              // boundary, never two, never zero.
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  flexShrink: 0,
                  marginTop: 12,
                  borderTop: "1px solid var(--t-border)",
                  paddingTop: 10,
                }}
              >
                <DpMetaRow task={task} />
              </div>
            )}
          </div>

          {/* ── Activity pane ── */}
          <div
            className="dp-pane"
            id="dp-activity-pane"
            style={{
              display: activeTab === "comments" && !isAdd ? "" : "none",
            }}
          >
            {/* Comment input at top */}
            <div
              style={{
                borderBottom: "1px solid var(--t-border)",
                paddingBottom: 8,
                flexShrink: 0,
              }}
            >
              <CommentsInputArea
                commentInput={commentInput}
                setCommentInput={setCommentInput}
                commentSubmitting={commentSubmitting}
                onSubmit={() => void handleSubmitComment()}
                baseRows={2}
                mentionTasks={mentionTasks}
                taskLookup={taskLookup}
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
              taskLookup={taskLookup}
            />
          </div>

          {/* ── Files pane ── */}
          <div
            className="dp-pane"
            id="dp-files-pane"
            style={{ display: activeTab === "files" && !isAdd ? "" : "none" }}
          >
            <FilesList
              files={files}
              loading={filesLoading}
              error={filesError}
              baseUrl={baseUrl}
              taskId={task?.id}
              pendingFiles={uploading}
              onPreview={(f) =>
                onFilePreview(
                  f.name,
                  f.linkedPath
                    ? `${baseUrl}/api/tasks/${task?.id}/files/${encodeURIComponent(f.name)}`
                    : `${baseUrl}${f.url}`,
                )
              }
              onDelete={handleDeleteFile}
            />
            <div
              style={{
                borderTop: "1px solid var(--t-border)",
                paddingTop: 8,
                flexShrink: 0,
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              {uploadError && (
                <div
                  style={{
                    width: "100%",
                    fontSize: 11,
                    color: "var(--t-danger)",
                    background: "rgba(255,80,80,0.08)",
                    border: "1px solid rgba(255,80,80,0.2)",
                    borderRadius: 5,
                    padding: "4px 8px",
                  }}
                >
                  {uploadError}
                </div>
              )}
              {uploading.length > 0 && (
                <div
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--t-text-muted)",
                    background: "rgba(37,99,235,0.08)",
                    border: "1px solid rgba(37,99,235,0.25)",
                    borderRadius: 5,
                    padding: "4px 8px",
                  }}
                >
                  <span className="spinner" aria-label="uploading" />
                  {uploading.length === 1
                    ? "Uploading pasted image…"
                    : `Uploading ${uploading.length} files…`}
                </div>
              )}
              <label
                aria-disabled={uploading.length > 0}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: uploading.length > 0 ? "wait" : "pointer",
                  padding: "6px 10px",
                  background: "var(--t-card)",
                  border: "1px solid var(--t-border)",
                  borderRadius: 8,
                  color: "var(--t-text-muted)",
                  fontSize: 12,
                  transition: "all .15s",
                  opacity: uploading.length > 0 ? 0.55 : 1,
                  pointerEvents: uploading.length > 0 ? "none" : "auto",
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.borderColor = "var(--t-border-faint)";
                  e.currentTarget.style.color = "var(--t-text)";
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.borderColor = "var(--t-border)";
                  e.currentTarget.style.color = "var(--t-text-muted)";
                }}
              >
                <Upload style={{ width: 12, height: 12 }} />
                {uploading.length > 0 ? "Uploading…" : "Upload"}
                <input
                  id="dp-file-upload"
                  type="file"
                  style={{ display: "none" }}
                  multiple
                  onChange={handleFileUpload}
                />
              </label>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--t-text-faint)",
                  marginLeft: "auto",
                }}
              >
                or paste image
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="dp-footer">
          {!isAdd && (
            <button
              id="dp-delete"
              onClick={() => setShowDeleteConfirm(true)}
              style={{
                color: "var(--t-danger)",
                background: "none",
                border: "1px solid var(--t-border-faint)",
                borderRadius: 7,
                padding: "5px 12px",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
                transition: "all .15s",
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.borderColor = "var(--t-danger)";
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.borderColor = "var(--t-border-faint)";
              }}
            >
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          {isAdd ? (
            <>
              {bufferingPaste && (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--t-accent-soft)",
                    marginRight: 8,
                    background: "rgba(37,99,235,0.1)",
                    border: "1px solid rgba(37,99,235,0.25)",
                    borderRadius: 6,
                    padding: "3px 8px",
                  }}
                >
                  Processing pasted image…
                </span>
              )}
              {bufferError && (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--t-danger)",
                    marginRight: 8,
                    background: "rgba(255,80,80,0.08)",
                    border: "1px solid rgba(255,80,80,0.2)",
                    borderRadius: 6,
                    padding: "3px 8px",
                  }}
                >
                  {bufferError}
                </span>
              )}
              {pendingPasteFiles.length > 0 && (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--t-accent-soft)",
                    marginRight: 8,
                    background: "rgba(37,99,235,0.1)",
                    border: "1px solid rgba(37,99,235,0.25)",
                    borderRadius: 6,
                    padding: "3px 8px",
                  }}
                >
                  📎 {pendingPasteFiles.length} screenshot
                  {pendingPasteFiles.length === 1 ? "" : "s"} will attach on
                  save
                </span>
              )}
              <button
                id="dp-cancel"
                onClick={onClose}
                style={{
                  padding: "5px 14px",
                  borderRadius: 7,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  border: "1px solid var(--t-border-faint)",
                  background: "var(--t-border)",
                  color: "var(--t-text-sub)",
                  fontFamily: "inherit",
                  transition: "all .15s",
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.borderColor = "var(--t-text-body)";
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.borderColor = "var(--t-border-faint)";
                }}
              >
                Cancel
              </button>
              <button
                id="dp-save"
                onClick={() => void handleSave()}
                style={{
                  padding: "5px 18px",
                  borderRadius: 7,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  border: "1px solid var(--t-accent-strong)",
                  background: "var(--t-accent)",
                  color: "var(--t-white)",
                  fontFamily: "inherit",
                  transition: "background .15s",
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.background = "var(--t-accent-strong)";
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.background = "var(--t-accent)";
                }}
              >
                Add Task
              </button>
            </>
          ) : (
            <span
              style={{
                fontSize: 11,
                color: "var(--t-text-body)",
                padding: "5px 4px",
              }}
            >
              Changes are saved automatically
            </span>
          )}
        </div>
        <ConfirmModal
          open={showDeleteConfirm}
          title="Delete task?"
          message={`You are about to permanently delete "${task?.title || "this task"}". This action cannot be undone.`}
          confirmLabel="Delete task"
          onConfirm={() => {
            setShowDeleteConfirm(false);
            onDelete(task!.id);
            onClose();
          }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      </aside>
      {showCommentSendConfirm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 201,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            background: "rgba(2,12,27,0.80)",
          }}
        >
          <div
            style={{
              background: "var(--t-surface)",
              border: "1px solid var(--t-border-strong)",
              borderRadius: 16,
              padding: "28px 32px",
              width: "100%",
              maxWidth: 480,
              boxShadow: "var(--t-shadow-lg)",
              position: "relative",
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "rgba(139,92,246,0.12)",
                border: "1px solid rgba(139,92,246,0.25)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 16,
              }}
            >
              <Upload
                style={{ width: 20, height: 20, color: "var(--t-secondary)" }}
              />
            </div>
            <h2
              style={{
                margin: "0 0 8px",
                fontSize: 17,
                fontWeight: 700,
                color: "var(--t-text)",
              }}
            >
              Send comment?
            </h2>
            <p
              style={{
                margin: "0 0 22px",
                fontSize: 13,
                color: "var(--t-text-faint)",
                lineHeight: 1.6,
              }}
            >
              You have an unsent comment. Do you want to send it before closing?
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  setShowCommentSendConfirm(false);
                  void handleSubmitComment().then(() => onClose());
                }}
                style={{
                  flex: 1,
                  padding: "9px 14px",
                  borderRadius: 8,
                  background: "var(--t-secondary)",
                  border: "none",
                  color: "var(--t-white)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Send &amp; Close
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCommentSendConfirm(false);
                  setCommentInput("");
                  onClose();
                }}
                style={{
                  padding: "9px 16px",
                  borderRadius: 8,
                  background: "var(--t-hover)",
                  border: "1px solid var(--t-border)",
                  color: "var(--t-text-muted)",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Discard &amp; Close
              </button>
              <button
                type="button"
                onClick={() => setShowCommentSendConfirm(false)}
                style={{
                  padding: "9px 16px",
                  borderRadius: 8,
                  background: "var(--t-hover)",
                  border: "1px solid var(--t-border)",
                  color: "var(--t-text-muted)",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Ticket 796f13e5: single source of truth for "does the meta chip row have
 * visible content". The details-pane wrapper gates on `length > 0`, so the
 * gate can never drift from what DpMetaRow actually renders — an
 * always-rendered empty wrapper is what sandwiched two dividers around
 * nothing (round 1) and left a floating gap with no divider (round 2).
 */
function buildDpMetaItems(task: Task): React.ReactNode[] {
  const items: React.ReactNode[] = [];

  if (task.component) {
    items.push(
      <span
        key="component"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          background: "color-mix(in srgb, var(--t-secondary) 14%, transparent)",
          border:
            "1px solid color-mix(in srgb, var(--t-secondary) 36%, transparent)",
          borderRadius: 100,
          fontSize: 10,
          color: "var(--t-chip-purple-300)",
          fontFamily: "monospace",
        }}
      >
        ⬡ {task.component}
      </span>,
    );
  }

  const hasSource =
    task.file || (task.selector && task.selector !== "/") || task.cssSelector;
  if (hasSource) {
    let fileLine = task.file ?? "";
    if (task.line != null) fileLine += `:${task.line}`;
    if (task.col != null) fileLine += `:${task.col}`;
    const selectorText =
      task.cssSelector ??
      (task.selector && task.selector !== "/" ? task.selector : "");
    const sourceText = fileLine || selectorText;
    if (sourceText) {
      const display =
        sourceText.length > 40 ? `…${sourceText.slice(-40)}` : sourceText;
      const urlDisplay = task.url
        ? task.url.length > 30
          ? `…${task.url.slice(-30)}`
          : task.url
        : "";
      items.push(
        <span
          key="source"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0,
            borderRadius: 6,
            overflow: "hidden",
            border:
              "1px solid color-mix(in srgb, var(--t-accent) 15%, transparent)",
            fontSize: 10,
            fontFamily: "monospace",
            whiteSpace: "nowrap",
          }}
        >
          <span
            title={[fileLine, selectorText].filter(Boolean).join(" · ")}
            style={{
              padding: "2px 6px",
              background: "color-mix(in srgb, var(--t-accent) 10%, transparent)",
              color: "var(--t-accent-soft)",
            }}
          >
            {display}
          </span>
          {urlDisplay && (
            <span
              title={task.url}
              style={{
                padding: "2px 6px",
                background:
                  "color-mix(in srgb, var(--t-border) 72%, transparent)",
                color: "var(--t-text-body)",
                borderLeft:
                  "1px solid color-mix(in srgb, var(--t-accent) 18%, transparent)",
              }}
            >
              {urlDisplay}
            </span>
          )}
        </span>,
      );
    }
  } else if (task.url) {
    const urlDisplay =
      task.url.length > 40 ? `…${task.url.slice(-40)}` : task.url;
    items.push(
      <span key="url" className="dp-source-pill" title={task.url}>
        {urlDisplay}
      </span>,
    );
  }

  if (task.reportBack) {
    items.push(
      <span
        key="rb"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          background: "color-mix(in srgb, var(--t-secondary) 10%, transparent)",
          border:
            "1px solid color-mix(in srgb, var(--t-secondary) 24%, transparent)",
          borderRadius: 100,
          fontSize: 10,
          color: "var(--t-chip-purple-300)",
        }}
      >
        ↩ report back
      </span>,
    );
  }

  return items;
}

function DpMetaRow({ task }: { task: Task }) {
  return (
    <div
      id="dp-meta-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        flex: 1,
      }}
    >
      {buildDpMetaItems(task)}
    </div>
  );
}
