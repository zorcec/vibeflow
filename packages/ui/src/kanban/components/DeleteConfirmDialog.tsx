import React from "react";
import { ModalBase } from "./ModalBase";

export type DeleteChildrenMode = "roots" | "recursive";

interface DeleteConfirmDialogProps {
  open: boolean;
  taskTitle: string;
  childCount: number;
  onCancel: () => void;
  onDelete: (mode: DeleteChildrenMode) => void;
  loading?: boolean;
}

/**
 * Delete confirmation dialog with orphan awareness.
 * Shows when the user tries to delete a task that has children.
 * Offers a radio choice (children become roots / delete whole subtree)
 * plus Cancel | Delete footer. This is the ONLY deletion surface.
 */
export function DeleteConfirmDialog({
  open,
  taskTitle,
  childCount,
  onCancel,
  onDelete,
  loading = false,
}: DeleteConfirmDialogProps) {
  const [mode, setMode] = React.useState<DeleteChildrenMode>("roots");
  React.useEffect(() => {
    if (open) setMode("roots");
  }, [open]);
  const danger = mode === "recursive";
  return (
    <ModalBase
      open={open}
      onClose={onCancel}
      id="delete-confirm-dialog"
      width="min(420px, 95vw)"
      title={`Delete "${taskTitle}"?`}
      footer={
        <>
          <button
            id="delete-confirm-cancel"
            onClick={onCancel}
            disabled={loading}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              background: "var(--t-hover)",
              border: "1px solid var(--t-border)",
              color: "var(--t-text-muted)",
              fontSize: 13,
              cursor: "pointer",
              transition: "background 0.15s",
            }}
          >
            Cancel
          </button>
          <button
            id="delete-confirm-delete"
            onClick={() => onDelete(mode)}
            disabled={loading}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              background: danger ? "var(--t-danger-strong)" : "var(--t-hover)",
              border: danger ? "none" : "1px solid var(--t-border)",
              color: danger ? "var(--t-white)" : "var(--t-text-faint)",
              fontSize: 13,
              fontWeight: 600,
              cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.6 : 1,
              transition: "background 0.15s",
            }}
          >
            {loading ? "…" : "Delete"}
          </button>
        </>
      }
    >
      <div style={{ padding: "16px 18px" }}>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: "var(--t-text-faint)",
            lineHeight: 1.6,
          }}
        >
          This task has{" "}
          <strong style={{ color: "var(--t-text)" }}>
            {childCount} child task{childCount === 1 ? "" : "s"}
          </strong>
          . What should happen to them?
        </p>
        <div
          role="radiogroup"
          aria-label="What to do with child tasks"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 12,
          }}
        >
          <DeleteModeOption
            id="delete-mode-roots"
            checked={mode === "roots"}
            onSelect={() => setMode("roots")}
            title="Delete parent only (children become root tasks)"
            hint="Children remain as root tasks with no parent."
          />
          <DeleteModeOption
            id="delete-mode-recursive"
            checked={mode === "recursive"}
            onSelect={() => setMode("recursive")}
            title={`Delete parent and all ${childCount} child task${childCount === 1 ? "" : "s"}`}
            hint="The whole subtree is permanently removed. This cannot be undone."
            warning
          />
        </div>
      </div>
    </ModalBase>
  );
}

function DeleteModeOption({
  id,
  checked,
  onSelect,
  title,
  hint,
  warning = false,
}: {
  id: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
  warning?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "9px 12px",
        borderRadius: 8,
        border: checked
          ? "1px solid var(--t-accent)"
          : "1px solid var(--t-border)",
        background: checked ? "var(--t-hover)" : "transparent",
        cursor: "pointer",
      }}
    >
      <input
        id={id}
        type="radio"
        name="delete-children-mode"
        checked={checked}
        onChange={onSelect}
        style={{ marginTop: 2, accentColor: "var(--t-accent)" }}
      />
      <span>
        <span
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 600,
            color: warning ? "var(--t-danger)" : "var(--t-text-faint)",
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 12,
            color: "var(--t-text-muted)",
            marginTop: 2,
          }}
        >
          {hint}
        </span>
      </span>
    </label>
  );
}
