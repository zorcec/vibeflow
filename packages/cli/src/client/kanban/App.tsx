import React from "react";
import { createPortal } from "react-dom";
import type {
  Task,
  TaskStatus,
  TaskLink,
  PanelState,
  AppSettings,
} from "@vibeflow-tools/ui/kanban";
import {
  KanbanHeader as Header,
  KanbanBoard,
  COLUMNS,
  KanbanListView,
  DetailPanel,
  FilterBar,
  SettingsModal,
  FilePreviewModal,
  computeReorder,
  compareTaskOrder,
  computeTreeReorder,
  maxSortKey,
  HeaderActionButton,
  getDescendants,
} from "@vibeflow-tools/ui/kanban";
import type { FilterState } from "@vibeflow-tools/ui/kanban";
import { api } from "./api.js";
import { captureAndStoreBaseline } from "../shared/baseline-capture.js";
import { WhatsNewModal } from "./WhatsNewModal.js";
import { DeleteConfirmDialog } from "@vibeflow-tools/ui/kanban";
import {
  fetchChangelogSections,
  markVersionSeen,
  readStoredVersion,
  shouldShowWhatsNew,
  type ChangelogSection,
} from "./whats-new.js";

type ViewMode = "board" | "compact" | "list";

// SAFETY: __PORT__ is injected by the CLI dev server at build time.
const PORT = (window as unknown as { __PORT__?: number }).__PORT__ ?? 3700;
// SAFETY: __SAAS_MODE__ is injected by the CLI build to switch UI behavior.
const SAAS_MODE =
  (window as unknown as { __SAAS_MODE__?: boolean }).__SAAS_MODE__ ?? false;
// SAFETY: __BOARD_URL__ is injected by the CLI build to point to the target page.
const BOARD_URL =
  (window as unknown as { __BOARD_URL__?: string }).__BOARD_URL__ ?? "";
// SAFETY: __BOARD_NAME__ is injected by the CLI server into the kanban HTML.
const BOARD_NAME =
  (window as unknown as { __BOARD_NAME__?: string }).__BOARD_NAME__ ?? "";
// SAFETY: __IS_ADMIN__ is injected by the CLI server into the kanban HTML.
const IS_ADMIN =
  (window as unknown as { __IS_ADMIN__?: boolean }).__IS_ADMIN__ ?? false;
// SAFETY: __CLI_VERSION__ is injected by the CLI server into the kanban HTML.
const CLI_VERSION =
  (window as unknown as { __CLI_VERSION__?: string }).__CLI_VERSION__ ?? "";
// SAFETY: __VIBEFLOW_USER__ is injected by the CLI server into the kanban HTML
// (process.env.USER ?? USERNAME) so per-user task state matches the CLI writer.
const CURRENT_USER_ID =
  (window as unknown as { __VIBEFLOW_USER__?: string }).__VIBEFLOW_USER__ ?? "";

type PushState = "idle" | "pushing" | "done" | "error";

function OnlineModeOverlay({ onClose }: { onClose?: () => void }) {
  const BASE = window.location.origin;
  const [pushState, setPushState] = React.useState<PushState>("idle");
  const [keepLocalFiles, setKeepLocalFiles] = React.useState(true);
  const [pushResult, setPushResult] = React.useState<{
    imported: number;
    skipped?: number;
  } | null>(null);
  const [pushError, setPushError] = React.useState("");

  async function handlePush() {
    setPushState("pushing");
    setPushError("");
    try {
      const r = await fetch(`${BASE}/api/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepLocalFiles }),
      });
      const data = (await r.json()) as {
        imported?: number;
        skipped?: number;
        error?: string;
      };
      if (!r.ok) {
        setPushError(data.error ?? "Push failed");
        setPushState("error");
        return;
      }
      setPushResult({ imported: data.imported ?? 0, skipped: data.skipped });
      setPushState("done");
    } catch (e) {
      setPushError(e instanceof Error ? e.message : "Network error");
      setPushState("error");
    }
  }

  const isWorking = pushState === "pushing";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(5, 8, 18, 0.72)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        fontFamily: "Inter, system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          background: "#101827",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: 24,
          maxWidth: 380,
          width: "100%",
          boxShadow:
            "0 0 0 1px rgba(59,130,246,0.07), 0 40px 80px rgba(0,0,0,0.75)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Top accent line */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: "20%",
            right: "20%",
            height: 1,
            background:
              "linear-gradient(90deg, transparent, rgba(59,130,246,0.5), transparent)",
          }}
        />

        {/* Hero */}
        <div
          style={{
            padding: "36px 36px 20px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
          }}
        >
          {/* Brand icon */}
          <div
            style={{
              position: "relative",
              width: 52,
              height: 52,
              marginBottom: 22,
            }}
          >
            <svg
              width="52"
              height="52"
              viewBox="0 0 18 18"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect width="18" height="18" rx="4" fill="#2563eb" />
              <rect
                x="2.5"
                y="5"
                width="2"
                height="8"
                rx="1"
                fill="white"
                opacity="0.7"
              />
              <rect x="6.5" y="2" width="2" height="14" rx="1" fill="white" />
              <rect
                x="10.5"
                y="6"
                width="2"
                height="6"
                rx="1"
                fill="white"
                opacity="0.7"
              />
              <rect
                x="14.5"
                y="4"
                width="2"
                height="10"
                rx="1"
                fill="white"
                opacity="0.85"
              />
            </svg>
          </div>

          <h1
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "#f1f5f9",
              letterSpacing: "-0.3px",
              margin: "0 0 7px",
            }}
          >
            Online Mode Active
          </h1>
          <p
            style={{
              fontSize: 12,
              color: "rgba(255,255,255,0.36)",
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            Connected to{" "}
            <strong
              style={{ color: "rgba(255,255,255,0.55)", fontWeight: 500 }}
            >
              {BOARD_NAME || "Vibeflow SaaS"}
            </strong>
          </p>
        </div>

        {/* Push banner */}
        {pushState === "done" && pushResult && (
          <div
            style={{
              margin: "0 28px 0",
              padding: "10px 14px",
              borderRadius: 9,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 9,
              background: "rgba(16,185,129,0.08)",
              border: "1px solid rgba(16,185,129,0.18)",
              color: "#34d399",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path
                d="M13 5L6.5 11.5 3 8"
                stroke="#34d399"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {pushResult.imported} task{pushResult.imported === 1 ? "" : "s"}{" "}
            pushed to board
            {pushResult.skipped != null && pushResult.skipped > 0
              ? ` · ${pushResult.skipped} already existed`
              : ""}
          </div>
        )}

        {pushState === "error" && pushError && (
          <div
            style={{
              margin: "0 28px 0",
              padding: "10px 14px",
              borderRadius: 9,
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 9,
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.18)",
              color: "#f87171",
            }}
          >
            {pushError}
          </div>
        )}

        {/* Actions */}
        <div
          style={{
            padding: "20px 24px 28px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {BOARD_URL && (
            <a
              href={BOARD_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 9,
                padding: 14,
                background: "#2563eb",
                border: "none",
                borderRadius: 12,
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                textDecoration: "none",
                letterSpacing: "-0.1px",
                transition: "background 0.15s, transform 0.1s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#3b82f6";
                e.currentTarget.style.transform = "translateY(-1px)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#2563eb";
                e.currentTarget.style.transform = "none";
              }}
            >
              Open Web App →
            </a>
          )}

          {pushState !== "done" && (
            <button
              onClick={() => void handlePush()}
              disabled={isWorking}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 9,
                padding: 12,
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 12,
                color: isWorking
                  ? "rgba(255,255,255,0.25)"
                  : "rgba(255,255,255,0.4)",
                fontSize: 13,
                fontWeight: 500,
                cursor: isWorking ? "not-allowed" : "pointer",
                transition: "border-color 0.15s, color 0.15s, background 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!isWorking) {
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
                  e.currentTarget.style.color = "rgba(255,255,255,0.65)";
                  e.currentTarget.style.background = "rgba(255,255,255,0.03)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isWorking) {
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
                  e.currentTarget.style.color = "rgba(255,255,255,0.4)";
                  e.currentTarget.style.background = "transparent";
                }
              }}
            >
              {isWorking ? "⏳ Pushing…" : "↑ Push local tasks"}
            </button>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 24px 20px",
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={keepLocalFiles}
              onChange={(e) => setKeepLocalFiles(e.target.checked)}
              style={{
                accentColor: "#2563eb",
                width: 13,
                height: 13,
                cursor: "pointer",
              }}
            />
            <span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.28)" }}>
              Keep local files
            </span>
          </label>
          {IS_ADMIN && onClose && (
            <button
              onClick={onClose}
              style={{
                fontSize: 11,
                color: "rgba(255,255,255,0.2)",
                background: "none",
                border: "none",
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 2,
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "rgba(255,255,255,0.45)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "rgba(255,255,255,0.2)";
              }}
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
  backlog: "Backlog",
  todo: "Todo",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
};

interface StatusEntry {
  taskId: string;
  field: string;
  from: string;
  to: string;
  actor: string;
  timestamp: string;
  source?: "cli" | "web";
}

function buildTaskSummary(
  tasks: Task[],
  _visibleCols: TaskStatus[],
  search: string,
): string {
  const filtered = search
    ? tasks.filter(
        (t) =>
          t.title?.toLowerCase().includes(search) ||
          t.description?.toLowerCase().includes(search),
      )
    : tasks;
  if (search) return `${filtered.length} of ${tasks.length} tasks`;
  const open = filtered.filter((t) => t.status !== "done").length;
  const wip = filtered.filter((t) => t.status === "in-progress").length;
  const rev = filtered.filter((t) => t.status === "review").length;
  return `${open} open · ${wip} in-progress · ${rev} in review`;
}

export function App() {
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [overlayDismissed, setOverlayDismissed] = React.useState(false);
  const [panelState, setPanelState] = React.useState<PanelState>({
    open: false,
    task: null,
    tab: "details",
  });
  const [viewMode, setViewMode] = React.useState<ViewMode>("board");
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [whatsNew, setWhatsNew] = React.useState<{
    open: boolean;
    startMode: "whatsnew" | "full";
    sections: ChangelogSection[];
    version: string;
    sinceVersion: string | null;
  }>({
    open: false,
    startMode: "whatsnew",
    sections: [],
    version: "",
    sinceVersion: null,
  });
  const [filePreview, setFilePreview] = React.useState({
    open: false,
    name: "",
    url: "",
  });
  const [panelWidth, setPanelWidth] = React.useState(420);
  const [isResizingPanel, setIsResizingPanel] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [visibleCols, setVisibleCols] = React.useState<TaskStatus[]>(
    COLUMNS.map((c) => c.id),
  );
  const [filterState, setFilterState] = React.useState<FilterState>({
    status: "all",
    component: null,
    type: null,
    user: null,
    tags: [],
  });
  const [projectName, setProjectName] = React.useState("Proto Board");
  const [wsConnected, setWsConnected] = React.useState(false);
  const [hadWsConnection, setHadWsConnection] = React.useState(false);
  const [gitUserName, setGitUserName] = React.useState("You");
  const [githubUrl, setGithubUrl] = React.useState<string | null>(null);
  const [appSettings, setAppSettings] = React.useState<AppSettings>({});
  const wsRef = React.useRef<WebSocket | null>(null);
  const wsRetryRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRetryAttemptRef = React.useRef<number>(0);
  const pollIntervalRef = React.useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const consumedHashTaskRef = React.useRef<string | null>(null);
  // Navigation history for task-ref jumping (supports browser back + UI back button).
  const [navHistory, setNavHistory] = React.useState<Task[]>([]);
  const suppressHistoryPushRef = React.useRef(false);
  // Keep a ref to latest tasks that WS handlers can read without stale closure.
  const tasksRef = React.useRef<Task[]>([]);
  // Delete confirmation dialog state
  const [deleteConfirm, setDeleteConfirm] = React.useState<{
    taskId: string;
    taskTitle: string;
    childCount: number;
  } | null>(null);
  // In-session log of status changes for the detail panel activity tab.
  const [statusChangeLog, setStatusChangeLog] = React.useState<StatusEntry[]>(
    [],
  );

  // Load initial data
  React.useEffect(() => {
    void loadTasks();
    void loadMeta();
    void loadAppSettings();
    void loadGithubUrl();
    void checkWhatsNew();
    connectWs();
    return () => {
      if (wsRetryRef.current) clearTimeout(wsRetryRef.current);
      wsRef.current?.close();
    };
  }, []);

  // Polling fallback: fetch tasks every 5s when WebSocket is disconnected.
  React.useEffect(() => {
    if (wsConnected) {
      // WS connected — stop polling fallback
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }
    // Start polling fallback when WS is disconnected
    pollIntervalRef.current = setInterval(() => {
      void loadTasks();
    }, 5000);
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [wsConnected]);

  React.useEffect(() => {
    document.body.setAttribute("data-theme", "dark");
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
      if (suppressHistoryPushRef.current) {
        setPanelState((prev) => ({
          ...prev,
          open: true,
          task,
          tab: "details",
        }));
      } else {
        setPanelState((prev) => {
          if (prev.task && prev.task.id !== task.id) {
            setNavHistory((h) => [...h, prev.task!]);
          }
          return { ...prev, open: true, task, tab: "details" };
        });
      }
      suppressHistoryPushRef.current = false;
    }

    openTaskFromHash();
    const onHashChange = () => {
      consumedHashTaskRef.current = null;
      openTaskFromHash();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [tasks]);

  // Keyboard shortcuts
  // Sync open panel task with live task updates (e.g. tag additions, status changes)
  React.useEffect(() => {
    if (!panelState.open || !panelState.task) return;
    const updated = tasks.find((t) => t.id === panelState.task!.id);
    if (!updated) return;
    const current = panelState.task;
    const changed = (Object.keys(updated) as (keyof typeof updated)[]).some(
      (k) => updated[k] !== current[k],
    );
    if (changed) setPanelState((prev) => ({ ...prev, task: updated }));
  }, [tasks, panelState.open, panelState.task?.id]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement)?.isContentEditable;
      if (e.key === "Escape") {
        if (filePreview.open) {
          setFilePreview((p) => ({ ...p, open: false }));
          return;
        }
        if (panelState.open) {
          setPanelState((p) => ({ ...p, open: false }));
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
      }
      if (inInput) return;
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        (
          document.getElementById(
            "header-shortcuts-hint",
          ) as HTMLButtonElement | null
        )?.click();
      }
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        (e.key === "n" || e.key === "N")
      ) {
        e.preventDefault();
        openPanel(null, "details");
      }
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        (e.key === "f" || e.key === "F")
      ) {
        e.preventDefault();
        const searchInput = document.getElementById(
          "global-search",
        ) as HTMLInputElement | null;
        searchInput?.focus();
        searchInput?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filePreview.open, panelState.open, settingsOpen]);

  function appendStatusChange(
    taskId: string,
    fromStatus: TaskStatus,
    toStatus: TaskStatus,
    actor: string,
    source?: "cli" | "web",
  ) {
    const timestamp = new Date().toISOString();
    const from = STATUS_LABELS[fromStatus] ?? fromStatus;
    const to = STATUS_LABELS[toStatus] ?? toStatus;
    const recent = Date.now() - 3000;
    setStatusChangeLog((prev) => {
      const duplicate = prev.some(
        (e) =>
          e.taskId === taskId &&
          e.to === to &&
          new Date(e.timestamp).getTime() > recent,
      );
      if (duplicate) return prev;
      return [
        ...prev,
        { taskId, field: "status", from, to, actor, timestamp, source },
      ].slice(-500);
    });
  }

  async function loadTasks() {
    try {
      const data = await api.getTasks();
      tasksRef.current = data.tasks ?? [];
      setTasks(data.tasks ?? []);
    } catch {
      /* keep the previous list — polling/WS fallback retries the load */
    } finally {
      setIsLoading(false);
    }
  }

  const upsertTaskFromWs = React.useCallback(
    (
      incoming: Record<string, unknown>,
      actor?: string,
      source?: "cli" | "web",
    ) => {
      const id = String(incoming.id ?? "");
      if (!id) return;
      const incomingCreated = incoming.created ?? incoming.createdAt;
      const updated = incoming.updated ? String(incoming.updated) : undefined;
      const commentCount = Array.isArray(incoming.comments)
        ? (incoming.comments as Array<{ deleted?: boolean }>).filter(
            (c) => !c.deleted,
          ).length
        : undefined;
      // Prefer the server-computed fileCount (listFiles source, includes
      // unregistered files on disk) over the refs-only files array length.
      const fileCount =
        typeof incoming.fileCount === "number"
          ? incoming.fileCount
          : Array.isArray(incoming.files)
            ? incoming.files.length
            : undefined;
      const newStatus = incoming.status
        ? (String(incoming.status) as TaskStatus)
        : undefined;

      // Cascade done: when the server sends cascadedDescendants (parent moved
      // to done), update children's status in the same state batch.
      const cascadedDescendants = Array.isArray(incoming.cascadedDescendants)
        ? (incoming.cascadedDescendants as Array<Record<string, unknown>>)
        : [];

      // Detect status change from remote WS event before updating state
      const prevTask = tasksRef.current.find((t) => t.id === id);
      if (newStatus && prevTask && prevTask.status !== newStatus) {
        appendStatusChange(
          id,
          prevTask.status,
          newStatus,
          actor ?? "Someone",
          source,
        );
      }

      setTasks((prev) => {
        const existing = prev.find((t) => t.id === id);
        const mapped: Task = {
          id,
          title: incoming.title
            ? String(incoming.title)
            : (existing?.title ?? "Untitled"),
          description:
            incoming.description == null
              ? (existing?.description ?? "")
              : String(incoming.description),
          status: (newStatus ?? existing?.status ?? "todo") as TaskStatus,
          type: incoming.type
            ? (String(incoming.type) as Task["type"])
            : existing?.type,
          priority: incoming.priority
            ? (String(incoming.priority) as Task["priority"])
            : existing?.priority,
          selector: incoming.selector
            ? String(incoming.selector)
            : existing?.selector,
          cssSelector: incoming.cssSelector
            ? String(incoming.cssSelector)
            : existing?.cssSelector,
          file: incoming.file ? String(incoming.file) : existing?.file,
          line:
            typeof incoming.line === "number" ? incoming.line : existing?.line,
          col: typeof incoming.col === "number" ? incoming.col : existing?.col,
          component: incoming.component
            ? String(incoming.component)
            : existing?.component,
          url: incoming.url ? String(incoming.url) : existing?.url,
          reportBack:
            incoming.reportBack === true || existing?.reportBack === true,
          commit: incoming.commit ? String(incoming.commit) : existing?.commit,
          commits: Array.isArray(incoming.commits)
            ? (incoming.commits as {
                sha: string;
                message: string;
                timestamp: string;
              }[])
            : existing?.commits,
          commentCount: commentCount ?? existing?.commentCount,
          fileCount: fileCount ?? existing?.fileCount,
          createdAt: incomingCreated
            ? String(incomingCreated)
            : (existing?.createdAt ?? new Date().toISOString()),
          updatedAt: updated ?? existing?.updatedAt,
          author: incoming.author ? String(incoming.author) : existing?.author,
          tags: Array.isArray(incoming.tags)
            ? (incoming.tags as string[])
            : existing?.tags,
          sortKey: incoming.sortKey
            ? String(incoming.sortKey)
            : existing?.sortKey,
          links: Array.isArray(incoming.links)
            ? (incoming.links as TaskLink[])
            : (existing?.links ?? []),
          // Per-user state — carried through WS updates, never dropped.
          openedBy: Array.isArray(incoming.openedBy)
            ? (incoming.openedBy as string[])
            : existing?.openedBy,
          expandedBy: Array.isArray(incoming.expandedBy)
            ? (incoming.expandedBy as string[])
            : existing?.expandedBy,
        };

        const next = prev.filter((t) => t.id !== id);
        next.push(mapped);
        next.sort((a, b) => {
          const aDate = new Date(a.updatedAt ?? a.createdAt ?? "").getTime();
          const bDate = new Date(b.updatedAt ?? b.createdAt ?? "").getTime();
          if (aDate === bDate) return a.id.localeCompare(b.id);
          return bDate - aDate;
        });
        tasksRef.current = next;
        return next;
      });

      // Cascade done: when the server sends cascadedDescendants (parent moved
      // to done), update children's status in the same state batch.
      if (cascadedDescendants.length > 0) {
        setTasks((prev) => {
          const next = prev.map((t) => {
            const cascade = cascadedDescendants.find((d) => d.id === t.id);
            if (cascade && cascade.status) {
              return { ...t, status: String(cascade.status) as TaskStatus };
            }
            return t;
          });
          tasksRef.current = next;
          return next;
        });
      }
      // appendStatusChange is stable (useCallback with empty deps); intentional empty dep array
    },
    [],
  );

  async function loadMeta() {
    try {
      const data = await api.getProject();
      if (data.name) setProjectName(data.name);
      if (data.gitUserName) setGitUserName(data.gitUserName);
    } catch {
      /* metadata is optional — display defaults stand */
    }
  }

  async function loadGithubUrl() {
    try {
      const data = (await fetch("/api/github-url").then((r) => r.json())) as {
        githubUrl: string | null;
      };
      setGithubUrl(data.githubUrl ?? null);
    } catch {
      /* optional feature — no URL simply hides the repo link */
    }
  }

  // Open the "What's New" modal once per CLI version after an update.
  async function checkWhatsNew() {
    const stored = readStoredVersion();
    let version = CLI_VERSION;
    let sections: ChangelogSection[] | null = null;
    if (!version) {
      // Dev/test builds have no injected version — the served changelog's
      // newest entry is the running CLI version by construction.
      sections = await fetchChangelogSections();
      version = sections[0]?.version ?? "";
    }
    if (!version) return; // cannot determine current version
    if (!stored) {
      // First visit: baseline to the current version, nothing to announce.
      markVersionSeen(version);
      return;
    }
    if (!shouldShowWhatsNew(stored, version)) return;
    const resolved = sections ?? (await fetchChangelogSections());
    if (resolved.length === 0) {
      // Nothing renderable — record the version so we do not refetch every load.
      markVersionSeen(version);
      return;
    }
    setWhatsNew({
      open: true,
      startMode: "whatsnew",
      sections: resolved,
      version,
      sinceVersion: stored,
    });
  }

  async function openFullChangelog() {
    const sections = whatsNew.sections.length
      ? whatsNew.sections
      : await fetchChangelogSections();
    const version = CLI_VERSION || sections[0]?.version || whatsNew.version;
    setWhatsNew({
      open: true,
      startMode: "full",
      sections,
      version,
      sinceVersion: null,
    });
  }

  function closeWhatsNew() {
    if (whatsNew.version) markVersionSeen(whatsNew.version);
    setWhatsNew((p) => ({ ...p, open: false }));
  }

  async function loadAppSettings() {
    try {
      const settingsData = await api.getSettings();
      const settings = settingsData as AppSettings;
      setAppSettings(settings);
      if (settings.visibleCols?.length) setVisibleCols(settings.visibleCols);
      // Stale persisted "condensed" (pre-compact) maps to compact.
      if (settings.viewMode)
        setViewMode(
          (settings.viewMode as string) === "condensed"
            ? "compact"
            : settings.viewMode,
        );
      if (
        settings.panelWidth &&
        settings.panelWidth >= 280 &&
        settings.panelWidth <= 900
      ) {
        setPanelWidth(settings.panelWidth);
      }
    } catch {
      /* built-in defaults apply when saved settings are unavailable */
    }
  }

  function connectWs() {
    const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsScheme}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.addEventListener("open", () => {
      setWsConnected(true);
      setHadWsConnection(true);
      wsRetryAttemptRef.current = 0;
      void loadTasks();
    });
    ws.addEventListener("close", () => {
      setWsConnected(false);
      // Retry WS connection every 2s
      if (wsRetryRef.current) clearTimeout(wsRetryRef.current);
      wsRetryRef.current = setTimeout(connectWs, 2000);
    });
    ws.addEventListener("error", () => {
      // On error, let 'close' handle reconnection
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "tasks-updated" || msg.type?.startsWith("task:")) {
          void loadTasks();
          return;
        }
        if (msg.type === "task-changed" && msg.task) {
          const task = msg.task as Record<string, unknown>;
          const actor =
            typeof task.alteredBy === "string"
              ? task.alteredBy
              : typeof task.author === "string"
                ? task.author
                : "Someone";
          const source = msg.source === "cli" ? ("cli" as const) : undefined;
          upsertTaskFromWs(task, actor, source);
          return;
        }
        if (msg.type === "task-deleted" && msg.taskId) {
          const taskId = String(msg.taskId);
          setTasks((prev) => {
            const next = prev.filter((t) => t.id !== taskId);
            tasksRef.current = next;
            return next;
          });
        }
      } catch {
        /* ignore malformed WS frames — keep the connection alive */
      }
    });
    // Keep-alive ping
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "ping" }));
    }, 20000);
    ws.addEventListener("close", () => clearInterval(pingInterval));
    ws.addEventListener("error", () => {});
  }

  async function patchTask(id: string, updates: Partial<Task>) {
    const previous = tasksRef.current.find((t) => t.id === id);
    setTasks((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...updates } : t));
      tasksRef.current = next;
      return next;
    });
    if (
      updates.status &&
      previous?.status &&
      updates.status !== previous.status
    ) {
      appendStatusChange(id, previous.status, updates.status, gitUserName);
    }
    try {
      const data = await api.updateTask(id, updates);
      if (data.task)
        setTasks((prev) => {
          const next = prev.map((t) => (t.id === id ? data.task! : t));
          tasksRef.current = next;
          return next;
        });
    } catch {
      void loadTasks();
    }
  }

  /** Persist the current user's card expand/collapse choice. Optimistic so the
   * inline tree reacts immediately; the server echoes the same value back. */
  async function setTaskExpanded(taskId: string, expanded: boolean) {
    if (!CURRENT_USER_ID) return;
    const previous = tasksRef.current.find((t) => t.id === taskId);
    const snapshot = previous?.expandedBy ?? [];
    const nextExpandedBy = expanded
      ? [...new Set([...snapshot, CURRENT_USER_ID])]
      : snapshot.filter((id) => id !== CURRENT_USER_ID);
    setTasks((prev) => {
      const next = prev.map((t) =>
        t.id === taskId ? { ...t, expandedBy: nextExpandedBy } : t,
      );
      tasksRef.current = next;
      return next;
    });
    try {
      await api.setTaskExpanded(taskId, expanded);
    } catch {
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, expandedBy: snapshot } : t,
        );
        tasksRef.current = next;
        return next;
      });
    }
  }

  /** Link draggedId as a child of parentId — optimistic PATCH. */
  async function linkChild(draggedId: string, parentId: string) {
    const task = tasksRef.current.find((t) => t.id === draggedId);
    const existingLinks = task?.links ?? [];
    const newLink = { taskId: parentId, type: "parent" as const };
    // Snapshot for revert on failure
    const snapshot = [...existingLinks];
    // Optimistic: set links locally immediately
    setTasks((prev) => {
      const next = prev.map((t) =>
        t.id === draggedId ? { ...t, links: [...existingLinks, newLink] } : t,
      );
      tasksRef.current = next;
      return next;
    });
    try {
      const data = await api.updateTask(draggedId, {
        links: [...existingLinks, newLink],
      });
      if (data.task) {
        setTasks((prev) => {
          const next = prev.map((t) => (t.id === draggedId ? data.task! : t));
          tasksRef.current = next;
          return next;
        });
      }
    } catch (err) {
      console.warn(
        `[Vibeflow] Failed to link child: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Revert optimistic update
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === draggedId ? { ...t, links: snapshot } : t,
        );
        tasksRef.current = next;
        return next;
      });
    }
  }

  /** Tree sibling reorder — resolve the drop against the rendered sibling
   * order with the shared computeTreeReorder plan, then persist the dragged
   * key plus every normalization patch the plan returns. */
  async function handleTreeReorder(
    draggedId: string,
    targetId: string,
    position: "before" | "after",
    parentId: string,
  ) {
    if (!draggedId || !targetId || !parentId) return;
    if (draggedId === targetId) return;
    const plan = computeTreeReorder(
      tasksRef.current,
      draggedId,
      parentId,
      targetId,
      position,
    );
    if (!plan) return;
    await patchTask(draggedId, { sortKey: plan.newSortKey });
    // Persist the re-keyed keyless siblings too: compareTaskOrder sorts a
    // keyless task after every keyed one, so persisting only the dragged key
    // lands it before those siblings on the next read.
    for (const patch of plan.normalizationPatches)
      await patchTask(patch.id, { sortKey: patch.sortKey });
  }

  /** Tree reparent — replace the parent link and assign an order sortKey with
   * snapshot revert on failure (mirrors linkChild). The key comes from the
   * same shared computeTreeReorder plan as a same-parent reorder, plus its
   * normalization patches for keyless siblings. */
  async function handleTreeReparent(
    draggedId: string,
    newParentId: string,
    targetId?: string,
    position?: "before" | "after",
  ) {
    if (!draggedId || !newParentId) return;
    if (draggedId === newParentId) return;
    const task = tasksRef.current.find((t) => t.id === draggedId);
    const existingLinks = task?.links ?? [];
    const snapshot = [...existingLinks];
    const previousSortKey = task?.sortKey;
    const newLink = { taskId: newParentId, type: "parent" as const };
    const nextLinks = [
      ...existingLinks.filter((l) => l?.type !== "parent"),
      newLink,
    ];
    // Order among the new siblings: around the drop target, else append-last.
    const plan = computeTreeReorder(
      tasksRef.current,
      draggedId,
      newParentId,
      targetId ?? null,
      position ?? "after",
    );
    if (!plan) return;
    const { newSortKey, normalizationPatches } = plan;
    // Snapshot the pre-drop keys of any keyless siblings so a failed PATCH can
    // revert them together with the dragged task.
    const patchSnapshot = new Map(
      normalizationPatches.map((p) => [
        p.id,
        tasksRef.current.find((t) => t.id === p.id)?.sortKey,
      ]),
    );
    setTasks((prev) => {
      const keys = new Map(
        normalizationPatches.map((p) => [p.id, p.sortKey] as const),
      );
      const next = prev.map((t) => {
        if (t.id === draggedId)
          return { ...t, links: nextLinks, sortKey: newSortKey };
        return keys.has(t.id) ? { ...t, sortKey: keys.get(t.id) } : t;
      });
      tasksRef.current = next;
      return next;
    });
    try {
      const data = await api.updateTask(draggedId, {
        links: nextLinks,
        sortKey: newSortKey,
      });
      if (data.task) {
        setTasks((prev) => {
          const next = prev.map((t) => (t.id === draggedId ? data.task! : t));
          tasksRef.current = next;
          return next;
        });
      }
      for (const patch of normalizationPatches)
        await patchTask(patch.id, { sortKey: patch.sortKey });
    } catch (err) {
      console.warn(
        `[Vibeflow] Failed to reparent: ${err instanceof Error ? err.message : String(err)}`,
      );
      setTasks((prev) => {
        const next = prev.map((t) => {
          if (t.id === draggedId)
            return { ...t, links: snapshot, sortKey: previousSortKey };
          return patchSnapshot.has(t.id)
            ? { ...t, sortKey: patchSnapshot.get(t.id) }
            : t;
        });
        tasksRef.current = next;
        return next;
      });
    }
  }

  /** Column drop of a parented task (drag-out): strip the parent link and
   * move status + sortKey in one full-replace PATCH — the links array
   * replace IS the unlink primitive, no server change needed. */
  async function handleColumnDrop(taskId: string, status: TaskStatus) {
    const task = tasksRef.current.find((t) => t.id === taskId);
    const links = task?.links ?? [];
    const hasParent = links.some((l) => l?.type === "parent");
    const colTasks = tasksRef.current
      .filter((t) => t?.status === status && t.id !== taskId)
      .sort(compareTaskOrder);
    // Append after the last column task. computeReorder also returns the
    // normalization patches that give keyless siblings real keys, so a
    // drag-out onto a mostly-keyless column still lands at the bottom: writing
    // only the new key would sort it before every keyless task on the next read
    // (see handleReorder).
    const { newSortKey, normalizationPatches } = computeReorder(
      colTasks,
      taskId,
      colTasks[colTasks.length - 1]?.id ?? null,
      null,
      maxSortKey(tasksRef.current),
      tasksRef.current,
    );
    // A parentless task dropped on the column background used to PATCH only
    // {status}. That discarded the drop position entirely: a same-column drop
    // sent the status it already had, which is a literal no-op (no key write,
    // no order change, no broadcast) and looked like the drop never happened.
    // The append key is persisted for parentless tasks too.
    if (hasParent) {
      const nextLinks = links.filter((l) => l?.type !== "parent");
      await patchTask(taskId, {
        status,
        links: nextLinks,
        sortKey: newSortKey,
      });
    } else {
      await patchTask(taskId, { status, sortKey: newSortKey });
    }
    for (const patch of normalizationPatches)
      await patchTask(patch.id, { sortKey: patch.sortKey });
  }

  async function handleReorder(
    taskId: string,
    newStatus: TaskStatus,
    beforeId: string | null,
    afterId: string | null,
    explicitSortKey?: string,
  ) {
    const colTasks = tasksRef.current
      .filter((t) => t.status === newStatus)
      .sort(compareTaskOrder);

    const result = computeReorder(
      colTasks,
      taskId,
      beforeId,
      afterId,
      maxSortKey(tasksRef.current),
      tasksRef.current,
    );
    const newSortKey = explicitSortKey ?? result.newSortKey;
    const normalizationPatches = result.normalizationPatches;

    // Apply optimistic updates for all affected tasks at once
    setTasks((prev) => {
      const patches = new Map<string, Partial<Task>>();
      for (const { id, sortKey } of normalizationPatches)
        patches.set(id, { sortKey });
      patches.set(taskId, { status: newStatus, sortKey: newSortKey });

      // Cascade done status: when a parent is moved to done, all
      // descendants are also marked done so the subtree completes together.
      if (newStatus === "done") {
        const descIds = getDescendants(prev, taskId);
        for (const descId of descIds) {
          patches.set(descId, { status: "done" });
        }
      }

      const next = prev.map((t) =>
        patches.has(t.id) ? { ...t, ...patches.get(t.id) } : t,
      );
      tasksRef.current = next;
      return next;
    });

    // Persist the dragged task AND every normalization patch. compareTaskOrder
    // sorts any keyed task before every keyless one, so writing only the
    // dragged key would re-key its keyless siblings in local state only and
    // drop them after the dragged card on the next read — the drop position is
    // silently discarded. The cascade-done path below needs no extra writes:
    // the server marks descendants done off the dragged task's status.
    try {
      await api.updateTask(taskId, { status: newStatus, sortKey: newSortKey });
      for (const patch of normalizationPatches)
        await api.updateTask(patch.id, { sortKey: patch.sortKey });
    } catch {
      // A partial failure (dragged task written, some patches not) self-heals
      // by re-reading server truth, which also reconciles the optimistic
      // cascade-done state — no snapshot revert needed here.
      void loadTasks();
    }
  }

  async function deleteTaskById(
    id: string,
    opts?: boolean | { unlinkChildren?: boolean; deleteChildren?: boolean },
  ) {
    const unlinkChildren =
      typeof opts === "boolean" ? opts : (opts?.unlinkChildren ?? false);
    const deleteChildren =
      typeof opts === "object" ? (opts?.deleteChildren ?? false) : false;
    setTasks((prev) => {
      // Optimistically drop the parent plus the whole known subtree so
      // recursively deleted cards vanish immediately; any mismatch with
      // the server is reconciled by the loadTasks fallback below.
      const remove = new Set<string>([id]);
      if (deleteChildren) {
        const queue = [id];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          for (const t of prev) {
            if (
              !remove.has(t.id) &&
              t.links?.some((l) => l.type === "parent" && l.taskId === cur)
            ) {
              remove.add(t.id);
              queue.push(t.id);
            }
          }
        }
      }
      const next = prev.filter((t) => !remove.has(t.id));
      tasksRef.current = next;
      return next;
    });
    try {
      await api.deleteTask(id, unlinkChildren, deleteChildren);
    } catch {
      void loadTasks();
    }
  }

  /** Unlink a child task from its parent — only removes the parent link, never deletes. */
  async function detachTaskById(id: string) {
    const task = tasksRef.current.find((t) => t.id === id);
    const parentLink = task?.links?.find((l) => l.type === "parent");
    const formerParentId = parentLink?.taskId;
    const directChildIds = tasksRef.current
      .filter((t) =>
        t.links?.some((l) => l.type === "parent" && l.taskId === id),
      )
      .map((t) => t.id);

    // Optimistic state update: remove the detached task, re-parent its direct
    // children to the former parent (or remove parent link if no former parent).
    setTasks((prev) =>
      prev
        .filter((t) => t.id !== id)
        .map((t) => {
          if (!directChildIds.includes(t.id)) return t;
          const newLinks = (t.links ?? []).filter(
            (l) => !(l.type === "parent" && l.taskId === id),
          );
          if (formerParentId) {
            newLinks.push({ type: "parent", taskId: formerParentId });
          }
          return { ...t, links: newLinks };
        }),
    );

    try {
      await api.detachTask(id);
    } catch {
      void loadTasks();
    }
  }

  async function createTask(draft: Partial<Task>): Promise<string | undefined> {
    try {
      const result = await api.createTask(
        draft as Parameters<typeof api.createTask>[0],
      );
      await loadTasks();
      // Capture baseline for the annotated element (fire-and-forget)
      if (result?.task?.id && draft.selector) {
        void captureAndStoreBaseline(result.task.id, draft.selector);
      }
      return result?.task?.id;
    } catch {
      /* request failed — caller treats a missing id as a no-op */
    }
  }

  function openPanel(
    task: Task | null,
    tab: PanelState["tab"] = "details",
    addColumnId?: TaskStatus,
  ) {
    // Direct panel opens (clicking a card) reset navigation history since
    // the user is starting a new navigation context.
    setNavHistory([]);
    setPanelState({ open: true, task, tab, addColumnId });
    // Opening a card marks it read for the current user (persistent read state),
    // mirroring `tasks --get`. The server broadcasts the updated task back.
    if (task?.id) void api.markOpened(task.id);
  }

  /** Navigate to a task from inside the detail panel (relation clicks, child clicks).
   *  Pushes the current task to nav history so the back button works. */
  function navigateToTask(nextTask: Task) {
    setPanelState((prev) => {
      if (prev.task && prev.task.id !== nextTask.id) {
        setNavHistory((h) => [...h, prev.task!]);
      }
      return { ...prev, open: true, task: nextTask, tab: "details" };
    });
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
      setPanelState((p) => ({
        ...p,
        open: true,
        task: prevTask,
        tab: "details",
      }));
      return newHistory;
    });
  }

  function openFilePreview(name: string, url: string) {
    // Only allow same-origin previews: reject absolute/external and non-http
    // (e.g. javascript:) URLs so a crafted file entry cannot drive window.open.
    const isSafeTarget =
      (url.startsWith("/") && !url.startsWith("//")) ||
      url.startsWith(window.location.origin + "/");
    if (!isSafeTarget) return;
    // HTML files open in a new tab for sandboxed preview; all others use the modal.
    if (/\.html?$/i.test(name)) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    setFilePreview({ open: true, name, url });
  }

  const taskSummary = buildTaskSummary(
    tasks,
    visibleCols,
    searchQuery.toLowerCase(),
  );
  const baseUrl = window.location.origin;

  const allTags = React.useMemo(() => {
    const set = new Set<string>();
    tasks.forEach((t) => (t.tags ?? []).forEach((tag) => set.add(tag)));
    return Array.from(set).sort();
  }, [tasks]);

  // Status changes filtered for the currently open task — fed to DetailPanel activity tab.
  const panelStatusChanges = React.useMemo(() => {
    const panelTaskId = panelState.task?.id;
    if (!panelTaskId) return [];
    return statusChangeLog
      .filter((e) => e.taskId === panelTaskId)
      .map(({ field, from, to, actor, timestamp, source }) => ({
        field,
        from,
        to,
        actor,
        timestamp,
        source,
      }));
  }, [panelState.task?.id, statusChangeLog]);

  const filteredTasks = React.useMemo(() => {
    let result = tasks;
    if (filterState.status !== "all") {
      result = result.filter((t) => t.status === filterState.status);
    }
    if (filterState.component) {
      result = result.filter((t) => t.component === filterState.component);
    }
    if (filterState.type) {
      result = result.filter((t) => t.type === filterState.type);
    }
    if (filterState.user) {
      result = result.filter((t) => t.author === filterState.user);
    }
    if (filterState.tags && filterState.tags.length > 0) {
      result = result.filter((t) =>
        filterState.tags!.every((tag) => (t.tags ?? []).includes(tag)),
      );
    }
    return result;
  }, [tasks, filterState]);

  const showLostConnectionOverlay = hadWsConnection && !wsConnected;

  return (
    <>
      {SAAS_MODE && !overlayDismissed && (
        <OnlineModeOverlay
          onClose={IS_ADMIN ? () => setOverlayDismissed(true) : undefined}
        />
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
          const next = current.includes(tag)
            ? current.filter((t) => t !== tag)
            : [...current, tag];
          setFilterState((prev) => ({ ...prev, tags: next }));
        }}
        isLoading={isLoading}
        taskSummary={taskSummary}
        onSearchChange={setSearchQuery}
        onSettings={() => setSettingsOpen(true)}
        extraActions={
          <HeaderActionButton
            id="changelog-btn"
            title="View changelog"
            onClick={() => void openFullChangelog()}
            label="Changelog"
          />
        }
      />

      <FilterBar
        tasks={tasks}
        filter={filterState}
        view={viewMode}
        onFilter={setFilterState}
        onViewChange={(mode) => {
          setViewMode(mode);
          void api.saveSettings({ ...appSettings, viewMode: mode });
          setAppSettings((prev) => ({ ...prev, viewMode: mode }));
        }}
      />

      <div
        className="flex flex-1 overflow-hidden"
        style={{ minHeight: 0, position: "relative" }}
      >
        {viewMode === "list" ? (
          <KanbanListView
            tasks={filteredTasks}
            searchQuery={searchQuery}
            isLoading={isLoading}
            onOpenPanel={(task, tab) => openPanel(task, tab)}
            onAddTask={(status) => openPanel(null, "details", status)}
            onDrop={(taskId, status) => patchTask(taskId, { status })}
          />
        ) : (
          <KanbanBoard
            tasks={filteredTasks}
            visibleCols={visibleCols}
            searchQuery={searchQuery}
            isLoading={isLoading}
            compact={viewMode === "compact"}
            onOpenPanel={(task, tab, colId) => openPanel(task, tab, colId)}
            onDrop={handleColumnDrop}
            onReorder={handleReorder}
            onLinkChild={linkChild}
            onTreeReorder={handleTreeReorder}
            onTreeReparent={handleTreeReparent}
            currentUserId={CURRENT_USER_ID}
            onToggleExpanded={(taskId, expanded) =>
              void setTaskExpanded(taskId, expanded)
            }
          />
        )}

        {panelState.open && (
          <div
            id="detail-panel-container"
            style={{ width: panelWidth, zIndex: isResizingPanel ? 30 : 10 }}
            className={isResizingPanel ? "resizing" : ""}
          >
            <div
              id="detail-panel-resize-handle"
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingPanel(true);
                document.body.classList.add("vibeflow-resizing-panel");
                const startX = e.clientX;
                const startWidth = panelWidth;
                const onMove = (ev: MouseEvent) => {
                  const next = startWidth - (ev.clientX - startX);
                  setPanelWidth(Math.max(360, Math.min(860, next)));
                };
                const onUp = (ev: MouseEvent) => {
                  setIsResizingPanel(false);
                  document.body.classList.remove("vibeflow-resizing-panel");
                  const finalWidth = Math.max(
                    360,
                    Math.min(860, startWidth - (ev.clientX - startX)),
                  );
                  void api.saveSettings({
                    ...appSettings,
                    panelWidth: finalWidth,
                  });
                  setAppSettings((prev) => ({
                    ...prev,
                    panelWidth: finalWidth,
                  }));
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
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
              onClose={() => {
                setNavHistory([]);
                setPanelState((p) => ({ ...p, open: false }));
              }}
              onSave={async (updates) => {
                if (panelState.task) {
                  await patchTask(panelState.task.id, updates);
                }
                setPanelState((p) => ({ ...p, open: false }));
              }}
              onCreate={async (draft) => {
                const taskId = await createTask(draft);
                setPanelState((p) => ({ ...p, open: false }));
                return taskId;
              }}
              onDelete={async (id) => {
                const task = tasksRef.current.find((t) => t.id === id);
                const childCount = tasksRef.current.filter((t) =>
                  t.links?.some((l) => l.type === "parent" && l.taskId === id),
                ).length;
                if (childCount > 0) {
                  setDeleteConfirm({
                    taskId: id,
                    taskTitle: task?.title ?? id,
                    childCount,
                  });
                } else {
                  await deleteTaskById(id);
                  setPanelState((p) => ({ ...p, open: false }));
                }
              }}
              onPatch={patchTask}
              onTreeReorder={handleTreeReorder}
              onTreeReparent={handleTreeReparent}
              onDetach={detachTaskById}
              onFilePreview={openFilePreview}
              onGoBack={navHistory.length > 0 ? goBack : undefined}
              navBackLabel={
                navHistory.length > 0
                  ? navHistory[navHistory.length - 1].title
                  : undefined
              }
              externalLocalChanges={panelStatusChanges}
              allTasks={tasks}
              onOpenTask={navigateToTask}
              createBranch={appSettings.createBranch}
            />
          </div>
        )}
      </div>

      {showLostConnectionOverlay &&
        createPortal(
          <div
            id="ws-lost-overlay"
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              width: "100vw",
              height: "100vh",
              zIndex: 99999,
              background: "rgba(2, 6, 23, 0.88)",
              backdropFilter: "blur(4px)",
              WebkitBackdropFilter: "blur(4px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              pointerEvents: "all",
              cursor: "not-allowed",
            }}
          >
            <div
              style={{
                width: "min(420px, 92vw)",
                borderRadius: 14,
                border: "1px solid var(--p-border-s)",
                background: "var(--p-card)",
                boxShadow: "0 16px 40px rgba(2,6,23,0.7)",
                padding: "20px 22px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                cursor: "default",
                pointerEvents: "auto",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--p-text-m)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    animation: "spin 1.1s linear infinite",
                    flexShrink: 0,
                  }}
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--p-text)",
                  }}
                >
                  Connection Lost
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--p-text-m)",
                  lineHeight: 1.6,
                }}
              >
                Real-time connection to the server was interrupted. Reconnecting
                in the background&hellip;
              </div>
            </div>
          </div>,
          document.body,
        )}

      <SettingsModal
        open={settingsOpen}
        visibleCols={visibleCols}
        settings={appSettings}
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
        onClose={() => setFilePreview((p) => ({ ...p, open: false }))}
      />

      <WhatsNewModal
        open={whatsNew.open}
        sections={whatsNew.sections}
        version={whatsNew.version}
        startMode={whatsNew.startMode}
        sinceVersion={whatsNew.sinceVersion}
        onClose={closeWhatsNew}
      />

      <DeleteConfirmDialog
        open={deleteConfirm !== null}
        taskTitle={deleteConfirm?.taskTitle ?? ""}
        childCount={deleteConfirm?.childCount ?? 0}
        onCancel={() => setDeleteConfirm(null)}
        onDelete={async (mode) => {
          if (!deleteConfirm) return;
          const id = deleteConfirm.taskId;
          setDeleteConfirm(null);
          if (mode === "recursive")
            await deleteTaskById(id, { deleteChildren: true });
          else await deleteTaskById(id);
          setPanelState((p) => ({ ...p, open: false }));
        }}
      />
    </>
  );
}
