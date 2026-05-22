"use client";

/**
 * TaskDetailPanel — a generic slide-in side panel for task details.
 *
 * Visual design matches the CLI kanban detail panel 1-1.
 * Accepts all data and callbacks as props so it works in both
 * the CLI (fetch-based) and SaaS (Next.js server actions) contexts.
 */

import React from "react";
import { X, Send, Trash2 } from "lucide-react";
import type { KanbanTask } from "./types";
import { TypePicker } from "./TypePicker";
import { PriorityBadge } from "./PriorityBadge";
import { MarkdownPreview } from "./MarkdownPreview";
import { renderMarkdown } from "./renderMarkdown";
import type { TaskType } from "./task-types";

export type TaskPriority = "Critical" | "High" | "Medium" | "Low";

export interface TaskComment {
  id: string;
  author: string;
  authorKind?: "user" | "agent" | "system";
  body: string;
  createdAt: string;
  edited?: boolean;
}

export interface TaskDetailPanelHandlers {
  onClose: () => void;
  onPatch: (id: string, patch: Partial<KanbanTask & { priority?: TaskPriority | null }>) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onLoadComments?: (taskId: string) => Promise<TaskComment[]>;
  onAddComment?: (taskId: string, body: string) => Promise<TaskComment>;
  onDeleteComment?: (taskId: string, commentId: string) => Promise<void>;
}

export interface StatusConfig {
  id: string;
  label: string;
  color: string;
}

interface Props {
  task: KanbanTask | null;
  workspaceId?: string;
  open: boolean;
  statuses: StatusConfig[];
  handlers: TaskDetailPanelHandlers;
}

// ── Styles ──────────────────────────────────────────────────────────────────

const input: React.CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  border: "1px solid var(--p-border-s)",
  borderRadius: 8,
  background: "var(--p-input)",
  color: "var(--p-text)",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
  transition: "border-color .12s, box-shadow .12s",
};

const metaLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--p-text-g)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: 6,
};

const dpTab = (active: boolean): React.CSSProperties => ({
  padding: "8px 14px",
  fontSize: 12,
  fontWeight: 500,
  color: active ? "var(--p-blue-300)" : "var(--p-text-g)",
  cursor: "pointer",
  background: "none",
  border: "none",
  borderBottom: active ? "2px solid var(--p-blue)" : "2px solid transparent",
  transition: "color .12s, border-color .12s",
});

// ── Component ────────────────────────────────────────────────────────────────

export function TaskDetailPanel({ task, open, statuses, handlers }: Props) {
  const [activeTab, setActiveTab] = React.useState<"details" | "comments">("details");

  // form state
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [priority, setPriority] = React.useState<TaskPriority | "">("");
  const [type, setType] = React.useState<TaskType>("Task");
  const [showDescPreview, setShowDescPreview] = React.useState(false);

  // comments
  const [comments, setComments] = React.useState<TaskComment[]>([]);
  const [commentsLoading, setCommentsLoading] = React.useState(false);
  const [commentsError, setCommentsError] = React.useState<string | null>(null);
  const [commentInput, setCommentInput] = React.useState("");
  const [commentSubmitting, setCommentSubmitting] = React.useState(false);
  const [showCommentPreview, setShowCommentPreview] = React.useState(false);
  const [deletingCommentId, setDeletingCommentId] = React.useState<string | null>(null);

  // misc
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);

  const titleRef = React.useRef<HTMLInputElement>(null);
  const commentInputRef = React.useRef<HTMLTextAreaElement>(null);
  const commentListRef = React.useRef<HTMLDivElement>(null);

  // Sync form when task changes
  React.useEffect(() => {
    if (!task) return;
    setTitle(task.title ?? "");
    setDescription(task.description ?? "");
    setPriority((task as KanbanTask & { priority?: TaskPriority }).priority ?? "");
    setType((task.type ?? "Task") as TaskType);
    setShowDescPreview(true);
    setComments([]);
    setCommentInput("");
    setCommentsError(null);
    setActiveTab("details");
  }, [task?.id]);

  // Load comments when switching to comments tab
  React.useEffect(() => {
    if (!open || !task || activeTab !== "comments") return;
    if (comments.length > 0) return;
    void loadComments(task.id);
  }, [activeTab, open, task?.id]);

  // Scroll to bottom of comments
  React.useEffect(() => {
    if (activeTab === "comments" && !commentsLoading && commentListRef.current) {
      requestAnimationFrame(() => {
        if (commentListRef.current) {
          commentListRef.current.scrollTop = commentListRef.current.scrollHeight;
        }
      });
    }
  }, [commentsLoading, comments.length, activeTab]);

  async function loadComments(taskId: string) {
    if (!handlers.onLoadComments) return;
    setCommentsLoading(true);
    setCommentsError(null);
    try {
      const loaded = await handlers.onLoadComments(taskId);
      setComments(loaded);
    } catch {
      setCommentsError("Failed to load comments.");
    } finally {
      setCommentsLoading(false);
    }
  }

  async function handleSaveTitle() {
    if (!task) return;
    const trimmed = title.trim();
    if (!trimmed || trimmed === (task.title ?? "")) return;
    setSaving(true);
    try {
      await handlers.onPatch(task.id, { title: trimmed });
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDescription() {
    if (!task) return;
    const trimmed = description.trim() || null;
    if (trimmed === (task.description ?? null)) return;
    setSaving(true);
    try {
      await handlers.onPatch(task.id, { description: trimmed });
    } finally {
      setSaving(false);
    }
  }

  async function handlePriorityChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value as TaskPriority | "";
    setPriority(val);
    if (!task) return;
    await handlers.onPatch(task.id, { priority: val || null });
  }

  async function handleTypeChange(newType: TaskType) {
    setType(newType);
    if (!task) return;
    await handlers.onPatch(task.id, { type: newType });
  }

  async function handleStatusChange(statusId: string) {
    if (!task || task.status === statusId) return;
    await handlers.onPatch(task.id, { status: statusId });
  }

  async function handleDelete() {
    if (!task) return;
    setDeleting(true);
    try {
      await handlers.onDelete(task.id);
      setShowDeleteConfirm(false);
      handlers.onClose();
    } finally {
      setDeleting(false);
    }
  }

  async function handleSubmitComment() {
    if (!task || !commentInput.trim() || !handlers.onAddComment) return;
    setCommentSubmitting(true);
    try {
      const added = await handlers.onAddComment(task.id, commentInput.trim());
      setComments((prev) => [...prev, added]);
      setCommentInput("");
      setShowCommentPreview(false);
    } finally {
      setCommentSubmitting(false);
    }
  }

  async function handleDeleteComment(commentId: string) {
    if (!task || !handlers.onDeleteComment) return;
    setDeletingCommentId(commentId);
    try {
      await handlers.onDeleteComment(task.id, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } finally {
      setDeletingCommentId(null);
    }
  }

  const hasCommentSupport = !!handlers.onLoadComments && !!handlers.onAddComment;

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          onClick={handlers.onClose}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 49,
            background: "rgba(2,12,27,0.30)",
          }}
        />
      )}

      {/* Panel */}
      <aside
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: "92vw",
          zIndex: 50,
          background: "var(--p-surface)",
          borderLeft: "1px solid var(--p-border-s)",
          boxShadow: "-8px 0 32px rgba(0,0,0,0.4)",
          display: "flex",
          flexDirection: "column",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.22s cubic-bezier(.25,.8,.25,1)",
          pointerEvents: open ? "auto" : "none",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            padding: "12px 16px 10px",
            borderBottom: "1px solid var(--p-border)",
            background: "var(--p-surface)",
            flexShrink: 0,
          }}
        >
          {/* Type + title + close */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <TypePicker value={type} onChange={handleTypeChange} />
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => void handleSaveTitle()}
              onKeyDown={(e) => { if (e.key === "Escape") handlers.onClose(); }}
              placeholder="Task title…"
              style={{
                flex: 1,
                fontSize: 14,
                fontWeight: 600,
                padding: "4px 8px",
                borderRadius: 6,
                border: "1px solid transparent",
                background: "transparent",
                color: "var(--p-text)",
                outline: "none",
                fontFamily: "inherit",
                transition: "border-color .12s, background .12s",
              }}
              onFocus={(e) => { e.target.style.borderColor = "var(--p-blue)"; e.target.style.background = "var(--p-input)"; }}
              onBlurCapture={(e) => { e.target.style.borderColor = "transparent"; e.target.style.background = "transparent"; }}
            />
            {saving && (
              <span style={{ fontSize: 10, color: "var(--p-text-g)", flexShrink: 0 }}>saving…</span>
            )}
            <button
              onClick={handlers.onClose}
              style={{ width: 26, height: 26, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, border: "none", background: "transparent", color: "var(--p-text-g)", cursor: "pointer" }}
              onMouseOver={(e) => { e.currentTarget.style.background = "var(--p-hover)"; e.currentTarget.style.color = "var(--p-text-m)"; }}
              onMouseOut={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--p-text-g)"; }}
            >
              <X style={{ width: 14, height: 14 }} />
            </button>
          </div>

          {/* Status buttons */}
          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, color: "var(--p-text-g)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em", marginRight: 2 }}>Status</span>
            {statuses.map((s) => {
              const isActive = task?.status === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => void handleStatusChange(s.id)}
                  style={{
                    padding: "3px 10px",
                    borderRadius: 6,
                    border: `1px solid ${isActive ? s.color : "var(--p-border)"}`,
                    background: isActive ? `color-mix(in srgb, ${s.color} 15%, transparent)` : "none",
                    color: isActive ? s.color : "var(--p-text-g)",
                    fontSize: 11,
                    fontWeight: 500,
                    cursor: "pointer",
                    transition: "all .12s",
                    fontFamily: "inherit",
                  }}
                  onMouseOver={(e) => { if (!isActive) { e.currentTarget.style.borderColor = "var(--p-border-t)"; e.currentTarget.style.color = "var(--p-text-m)"; } }}
                  onMouseOut={(e) => { if (!isActive) { e.currentTarget.style.borderColor = "var(--p-border)"; e.currentTarget.style.color = "var(--p-text-g)"; } }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Tabs ── */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid var(--p-border)",
            background: "var(--p-surface)",
            flexShrink: 0,
          }}
        >
          <button style={dpTab(activeTab === "details")} onClick={() => setActiveTab("details")}>Details</button>
          {hasCommentSupport && (
            <button style={dpTab(activeTab === "comments")} onClick={() => {
              setActiveTab("comments");
              if (task && comments.length === 0 && !commentsLoading) void loadComments(task.id);
            }}>
              Comments{task?.commentCount ? ` (${task.commentCount})` : comments.length > 0 ? ` (${comments.length})` : ""}
            </button>
          )}
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>

          {/* Details pane */}
          {activeTab === "details" && (
            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Description */}
              <div>
                <div style={metaLabel}>Description</div>
                {showDescPreview && description ? (
                  <button
                    onClick={() => setShowDescPreview(false)}
                    style={{ display: "block", width: "100%", textAlign: "left", background: "var(--p-input)", border: "1px solid var(--p-border-s)", borderRadius: 8, padding: "8px 10px", cursor: "text", minHeight: 60 }}
                    onMouseOver={(e) => { e.currentTarget.style.borderColor = "var(--p-border-t)"; }}
                    onMouseOut={(e) => { e.currentTarget.style.borderColor = "var(--p-border-s)"; }}
                    title="Click to edit"
                  >
                    <MarkdownPreview
                      markdown={description}
                      style={{ fontSize: 12, color: "var(--p-text-sub)", lineHeight: 1.65 }}
                    />
                  </button>
                ) : (
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    onBlur={() => { void handleSaveDescription(); if (description.trim()) setShowDescPreview(true); }}
                    autoFocus={!showDescPreview}
                    placeholder="Description (markdown)…"
                    rows={6}
                    style={{
                      ...input,
                      minHeight: 100,
                      fontFamily: "monospace",
                      fontSize: 12,
                      lineHeight: 1.6,
                      resize: "vertical",
                    }}
                    onFocus={(e) => { e.target.style.borderColor = "var(--p-blue)"; e.target.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.1)"; }}
                    onBlurCapture={(e) => { e.target.style.borderColor = "var(--p-border-s)"; e.target.style.boxShadow = ""; }}
                  />
                )}
              </div>

              {/* Priority */}
              <div>
                <div style={metaLabel}>Priority</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <select
                    value={priority}
                    onChange={(e) => void handlePriorityChange(e)}
                    style={{ ...input, padding: "5px 8px", fontSize: 12, cursor: "pointer", width: "auto", minWidth: 120 }}
                  >
                    <option value="">—</option>
                    <option value="Critical">Critical</option>
                    <option value="High">High</option>
                    <option value="Medium">Medium</option>
                    <option value="Low">Low</option>
                  </select>
                  {priority && <PriorityBadge priority={priority} />}
                </div>
              </div>

              {/* Metadata */}
              {task && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 4 }}>
                  <MetaTile label="Created">{task.createdAt ? formatRelativeDate(task.createdAt) : "—"}</MetaTile>
                  <MetaTile label="ID"><span style={{ fontFamily: "monospace" }}>{task.id.slice(0, 8)}</span></MetaTile>
                </div>
              )}
            </div>
          )}

          {/* Comments pane */}
          {activeTab === "comments" && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              {/* Comment list */}
              <div
                ref={commentListRef}
                style={{ flex: 1, padding: "12px 16px", overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 10 }}
              >
                {commentsLoading && (
                  <p style={{ color: "var(--p-text-g)", fontSize: 12, textAlign: "center", padding: "16px 0" }}>Loading…</p>
                )}
                {commentsError && (
                  <p style={{ color: "var(--p-red)", fontSize: 12, textAlign: "center", padding: "8px 0" }}>{commentsError}</p>
                )}
                {!commentsLoading && !commentsError && comments.length === 0 && (
                  <p style={{ color: "var(--p-text-g)", fontSize: 12, textAlign: "center", padding: "16px 0" }}>No comments yet.</p>
                )}
                {comments.map((c) => (
                  <CommentBubble
                    key={c.id}
                    comment={c}
                    deleting={deletingCommentId === c.id}
                    canDelete={!!handlers.onDeleteComment}
                    onDelete={() => void handleDeleteComment(c.id)}
                  />
                ))}
              </div>

              {/* Comment input */}
              <div style={{ borderTop: "1px solid var(--p-border)", padding: "10px 16px 14px", flexShrink: 0 }}>
                {showCommentPreview && commentInput.trim() ? (
                  <button
                    onClick={() => setShowCommentPreview(false)}
                    style={{ display: "block", width: "100%", textAlign: "left", background: "var(--p-input)", border: "1px solid var(--p-border-s)", borderRadius: 8, padding: "8px 10px", cursor: "text", minHeight: 54 }}
                    title="Click to edit"
                  >
                    <MarkdownPreview
                      markdown={commentInput}
                      style={{ fontSize: 12, color: "var(--p-text-sub)", lineHeight: 1.65 }}
                    />
                  </button>
                ) : (
                  <div style={{ position: "relative" }}>
                    <textarea
                      ref={commentInputRef}
                      value={commentInput}
                      onChange={(e) => setCommentInput(e.target.value)}
                      onBlur={() => { if (commentInput.trim()) setShowCommentPreview(true); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          void handleSubmitComment();
                        }
                      }}
                      placeholder="Add a comment… (markdown, Ctrl+Enter to send)"
                      rows={3}
                      style={{
                        ...input,
                        paddingRight: 40,
                        fontFamily: "monospace",
                        fontSize: 12,
                        lineHeight: 1.6,
                        resize: "none",
                      }}
                      onFocus={(e) => { e.target.style.borderColor = "var(--p-blue)"; e.target.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.1)"; }}
                      onBlurCapture={(e) => { e.target.style.borderColor = "var(--p-border-s)"; e.target.style.boxShadow = ""; }}
                    />
                    <button
                      disabled={commentSubmitting || !commentInput.trim()}
                      onMouseDown={(e) => { e.preventDefault(); void handleSubmitComment(); }}
                      title="Send (Ctrl+Enter)"
                      style={{
                        position: "absolute",
                        bottom: 6,
                        right: 8,
                        width: 26,
                        height: 26,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: commentInput.trim() ? "var(--p-purple)" : "var(--p-border)",
                        border: "none",
                        borderRadius: 6,
                        cursor: commentInput.trim() ? "pointer" : "default",
                        color: "var(--p-white)",
                        transition: "background .15s",
                      }}
                    >
                      <Send style={{ width: 12, height: 12 }} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div
          style={{
            padding: "10px 16px 12px",
            borderTop: "1px solid var(--p-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            background: "var(--p-surface)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={deleting}
            style={{
              color: "var(--p-red)",
              background: "none",
              border: "1px solid var(--p-border-t)",
              borderRadius: 7,
              padding: "5px 12px",
              fontSize: 12,
              cursor: deleting ? "wait" : "pointer",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              gap: 5,
              opacity: deleting ? 0.5 : 1,
              transition: "border-color .15s",
            }}
            onMouseOver={(e) => { if (!deleting) e.currentTarget.style.borderColor = "var(--p-red)"; }}
            onMouseOut={(e) => { e.currentTarget.style.borderColor = "var(--p-border-t)"; }}
          >
            <Trash2 style={{ width: 12, height: 12 }} />
            {deleting ? "Deleting…" : "Delete"}
          </button>
          <button
            onClick={handlers.onClose}
            style={{
              padding: "5px 16px",
              borderRadius: 7,
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              border: "1px solid var(--p-border-t)",
              background: "var(--p-hover)",
              color: "var(--p-text-m)",
              fontFamily: "inherit",
              transition: "border-color .15s",
            }}
            onMouseOver={(e) => { e.currentTarget.style.borderColor = "var(--p-text-g)"; }}
            onMouseOut={(e) => { e.currentTarget.style.borderColor = "var(--p-border-t)"; }}
          >
            Close
          </button>
        </div>
      </aside>
      {showDeleteConfirm && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", background: "rgba(2,12,27,0.80)" }}
          onClick={(e) => { if (e.target === e.currentTarget && !deleting) setShowDeleteConfirm(false); }}
        >
          <div style={{ background: "var(--p-surface)", border: "1px solid var(--p-border-s)", borderRadius: 16, padding: "28px 32px", width: "100%", maxWidth: 400, boxShadow: "var(--p-shadow-lg)", position: "relative" }}>
            <button onClick={() => setShowDeleteConfirm(false)} disabled={deleting} style={{ position: "absolute", top: 14, right: 14, background: "none", border: "none", cursor: "pointer", color: "var(--p-text-g)", padding: 4, display: "flex", borderRadius: 6 }}>
              <X style={{ width: 16, height: 16 }} />
            </button>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: "rgba(220,38,38,0.12)", border: "1px solid rgba(220,38,38,0.25)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
              <Trash2 style={{ width: 20, height: 20, color: "#f87171" }} />
            </div>
            <h2 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 700, color: "var(--p-text)" }}>Delete task?</h2>
            <p style={{ margin: "0 0 6px", fontSize: 13, color: "var(--p-text-f)", lineHeight: 1.6 }}>
              You are about to permanently delete <strong style={{ color: "var(--p-text-m)" }}>{task?.title || "this task"}</strong>.
            </p>
            <p style={{ margin: "0 0 22px", fontSize: 12, color: "var(--p-text-g)", lineHeight: 1.5 }}>This action cannot be undone.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => void handleDelete()}
                disabled={deleting}
                style={{ flex: 1, padding: "9px 14px", borderRadius: 8, background: "#dc2626", border: "none", color: "#fff", fontSize: 13, fontWeight: 600, cursor: deleting ? "wait" : "pointer", opacity: deleting ? 0.6 : 1 }}
              >{deleting ? "Deleting…" : "Delete task"}</button>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                style={{ padding: "9px 16px", borderRadius: 8, background: "var(--p-hover)", border: "1px solid var(--p-border)", color: "var(--p-text-m)", fontSize: 13, cursor: "pointer" }}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function CommentBubble({
  comment,
  canDelete,
  deleting,
  onDelete,
}: {
  comment: TaskComment;
  canDelete: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const isAgent = comment.authorKind === "agent";
  const isSystem = comment.authorKind === "system";

  if (isSystem) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", fontSize: 11, color: "var(--p-text-g)", fontStyle: "italic" }}>
        <span style={{ opacity: 0.5 }}>⬡</span>
        <span>{comment.body}</span>
        <span style={{ marginLeft: "auto", flexShrink: 0, opacity: 0.6, fontFamily: "monospace" }}>
          {formatRelativeDate(comment.createdAt)}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        background: isAgent ? "rgba(99,102,241,0.06)" : "var(--p-card)",
        border: `1px solid ${isAgent ? "rgba(99,102,241,0.2)" : "var(--p-border)"}`,
        borderRadius: 10,
        padding: "9px 11px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Author + time */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: isAgent ? "var(--p-purple-300)" : "var(--p-text-m)",
          }}
        >
          {isAgent ? "🤖 Agent" : comment.author}
        </span>
        {comment.edited && <span style={{ fontSize: 9, color: "var(--p-text-g)", fontStyle: "italic" }}>(edited)</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--p-text-g)", fontFamily: "monospace" }}>
          {formatRelativeDate(comment.createdAt)}
        </span>
        {canDelete && !isAgent && (
          <button
            onClick={onDelete}
            disabled={deleting}
            title="Delete comment"
            style={{
              background: "none",
              border: "none",
              cursor: deleting ? "wait" : "pointer",
              color: "var(--p-text-g)",
              padding: "0 2px",
              display: "flex",
              opacity: deleting ? 0.5 : 1,
            }}
            onMouseOver={(e) => { e.currentTarget.style.color = "var(--p-red)"; }}
            onMouseOut={(e) => { e.currentTarget.style.color = "var(--p-text-g)"; }}
          >
            <Trash2 style={{ width: 11, height: 11 }} />
          </button>
        )}
      </div>

      {/* Body */}
      <div
        // renderMarkdown() HTML-escapes &, <, > before processing — no raw user HTML
        dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.body) }}
        style={{ fontSize: 12, color: "var(--p-text-sub)", lineHeight: 1.65 }}
      />
    </div>
  );
}

function MetaTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--p-card)", borderRadius: 8, padding: "7px 10px" }}>
      <div style={{ fontSize: 9, color: "var(--p-text-g)", marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ fontSize: 11, color: "var(--p-text-f)" }}>{children}</div>
    </div>
  );
}

function formatRelativeDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
