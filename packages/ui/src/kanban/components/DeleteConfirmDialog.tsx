import React from "react";
import { ModalBase } from "./ModalBase";

export type DeleteChildrenMode = "keep" | "unlink" | "recursive";

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
 * Offers a radio choice (keep as separate tasks / unlink to roots /
 * delete the whole subtree) plus Cancel | Delete footer.
 */
export function DeleteConfirmDialog({
  open,
  taskTitle,
  childCount,
  onCancel,
  onDelete,
  loading = false,
}: DeleteConfirmDialogProps) {
  const [mode, setMode] = React.useState<DeleteChildrenMode>("keep");
  React.useEffect(() => {
    if (open) setMode("keep");
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
              background: "var(--p-hover)",
              border: "1px solid var(--p-border)",
              color: "var(--p-text-m)",
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
              background: danger ? "#dc2626" : "var(--p-hover)",
              border: danger ? "none" : "1px solid var(--p-border)",
              color: danger ? "#fff" : "var(--p-text-f)",
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
            color: "var(--p-text-f)",
            lineHeight: 1.6,
          }}
        >
          This task has{" "}
          <strong style={{ color: "var(--p-text)" }}>
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
            id="delete-mode-keep"
            checked={mode === "keep"}
            onSelect={() => setMode("keep")}
            title="Keep children as separate tasks"
            hint="Children remain as root tasks with no parent."
          />
          <DeleteModeOption
            id="delete-mode-unlink"
            checked={mode === "unlink"}
            onSelect={() => setMode("unlink")}
            title="Delete parent only, unlink children"
            hint="Parent link is removed; children become root tasks."
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
          ? "1px solid var(--p-blue, #60a5fa)"
          : "1px solid var(--p-border)",
        background: checked ? "var(--p-hover)" : "transparent",
        cursor: "pointer",
      }}
    >
      <input
        id={id}
        type="radio"
        name="delete-children-mode"
        checked={checked}
        onChange={onSelect}
        style={{ marginTop: 2, accentColor: "var(--p-blue, #60a5fa)" }}
      />
      <span>
        <span
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 600,
            color: warning ? "#f87171" : "var(--p-text-f)",
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 12,
            color: "var(--p-text-m)",
            marginTop: 2,
          }}
        >
          {hint}
        </span>
      </span>
    </label>
  );
}
