import React from "react";
import { ModalBase } from "@vibeflow-tools/ui/kanban";

interface DeleteConfirmDialogProps {
  open: boolean;
  taskTitle: string;
  childCount: number;
  onCancel: () => void;
  onDeleteOnly: () => void;
  onDeleteAndUnlink: () => void;
  loading?: boolean;
}

/**
 * Delete confirmation dialog with orphan awareness.
 * Shows when the user tries to delete a task that has children.
 * Offers: Cancel | Delete parent only | Delete parent and unlink children.
 */
export function DeleteConfirmDialog({
  open,
  taskTitle,
  childCount,
  onCancel,
  onDeleteOnly,
  onDeleteAndUnlink,
  loading = false,
}: DeleteConfirmDialogProps) {
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
            id="delete-confirm-delete-only"
            onClick={onDeleteOnly}
            disabled={loading}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              background: "var(--p-hover)",
              border: "1px solid var(--p-border)",
              color: "var(--p-text-f)",
              fontSize: 13,
              fontWeight: 500,
              cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.6 : 1,
              transition: "background 0.15s",
            }}
          >
            {loading ? "…" : "Delete parent only"}
          </button>
          <button
            id="delete-confirm-unlink"
            onClick={onDeleteAndUnlink}
            disabled={loading}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              background: "#dc2626",
              border: "none",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.6 : 1,
              transition: "background 0.15s",
            }}
          >
            {loading ? "…" : "Delete and unlink children"}
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
          </strong>{" "}
          that will become orphaned (no parent).
        </p>
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 12,
            color: "var(--p-text-m)",
            lineHeight: 1.5,
          }}
        >
          <strong>Delete parent only</strong> — children remain as orphaned root
          tasks.
          <br />
          <strong>Delete and unlink children</strong> — children become root
          tasks with no parent link.
        </p>
      </div>
    </ModalBase>
  );
}
