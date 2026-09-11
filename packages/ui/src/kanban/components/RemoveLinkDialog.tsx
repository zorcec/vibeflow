import React from "react";
import { ModalBase } from "./ModalBase";
import { AlertTriangle } from "lucide-react";

interface RemoveLinkDialogProps {
  open: boolean;
  childTitle: string;
  childCount: number;
  onCancel: () => void;
  onConfirm: (deleteChildren: boolean) => void;
  loading?: boolean;
}

/**
 * Remove-link confirmation dialog with child awareness.
 * Childless child: single confirm ("Remove parent link? It becomes a root task.")
 * Has children: radio list — move children up (safe) or delete subtree (destructive).
 */
export function RemoveLinkDialog({
  open,
  childTitle,
  childCount,
  onCancel,
  onConfirm,
  loading = false,
}: RemoveLinkDialogProps) {
  const [deleteChildren, setDeleteChildren] = React.useState(false);

  // Reset radio when dialog opens
  React.useEffect(() => {
    if (open) setDeleteChildren(false);
  }, [open]);

  const hasChildren = childCount > 0;

  return (
    <ModalBase
      open={open}
      onClose={onCancel}
      id="remove-link-dialog"
      width="min(420px, 95vw)"
      title="Remove parent link?"
      icon={
        <AlertTriangle style={{ width: 20, height: 20, color: "#f87171" }} />
      }
      footer={
        <>
          <button
            id="remove-link-cancel"
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
            id="remove-link-confirm"
            onClick={() => onConfirm(deleteChildren)}
            disabled={loading}
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              background: deleteChildren ? "#dc2626" : "#2563eb",
              border: "none",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.6 : 1,
              transition: "background 0.15s",
            }}
          >
            {loading ? "…" : "Remove"}
          </button>
        </>
      }
    >
      <div style={{ padding: "16px 18px" }}>
        {hasChildren ? (
          <>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: "var(--p-text-f)",
                lineHeight: 1.6,
              }}
            >
              <strong style={{ color: "var(--p-text)" }}>
                &ldquo;{childTitle}&rdquo;
              </strong>{" "}
              has{" "}
              <strong style={{ color: "var(--p-text)" }}>
                {childCount} child task{childCount === 1 ? "" : "s"}
              </strong>
              .
            </p>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  cursor: "pointer",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: `1px solid ${deleteChildren ? "var(--p-border)" : "var(--p-blue-300, #60a5fa)"}`,
                  background: deleteChildren ? "transparent" : "rgba(59, 130, 246, 0.06)",
                  transition: "border-color 0.15s, background 0.15s",
                }}
              >
                <input
                  type="radio"
                  name="remove-link-mode"
                  checked={!deleteChildren}
                  onChange={() => setDeleteChildren(false)}
                  style={{ marginTop: 2, accentColor: "#2563eb" }}
                />
                <span style={{ fontSize: 13, color: "var(--p-text-f)", lineHeight: 1.5 }}>
                  <strong style={{ color: "var(--p-text)" }}>Children move up</strong>{" "}
                  — task becomes root; its children re-parent to the former parent.
                </span>
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  cursor: "pointer",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: `1px solid ${deleteChildren ? "#f87171" : "var(--p-border)"}`,
                  background: deleteChildren ? "rgba(248, 113, 113, 0.06)" : "transparent",
                  transition: "border-color 0.15s, background 0.15s",
                }}
              >
                <input
                  type="radio"
                  name="remove-link-mode"
                  checked={deleteChildren}
                  onChange={() => setDeleteChildren(true)}
                  style={{ marginTop: 2, accentColor: "#dc2626" }}
                />
                <span style={{ fontSize: 13, color: "var(--p-text-f)", lineHeight: 1.5 }}>
                  <strong style={{ color: "#f87171" }}>Delete children</strong>{" "}
                  — task becomes root; its subtree is deleted. Task itself survives.
                </span>
              </label>
            </div>
          </>
        ) : (
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: "var(--p-text-f)",
              lineHeight: 1.6,
            }}
          >
            Remove parent link from{" "}
            <strong style={{ color: "var(--p-text)" }}>
              &ldquo;{childTitle}&rdquo;
            </strong>
            ? It will become a root task.
          </p>
        )}
      </div>
    </ModalBase>
  );
}
