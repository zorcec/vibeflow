import React from "react";
import type { FileEntry } from "../../types";
import { ConfirmModal } from "../ConfirmModal";
import { FileItem } from "./FileItem";

/** System files: engine-written baselines and verify evidence, flagged by the server at write time. User files: everything else. */
function isSystemFile(f: FileEntry): boolean {
  return f.system === true;
}

interface Props {
  files: FileEntry[];
  loading: boolean;
  error: string | null;
  baseUrl: string;
  /** Kept for caller compatibility; grouping no longer consults it. */
  taskId?: string;
  onPreview: (f: FileEntry) => void;
  onDelete?: (f: FileEntry) => Promise<void>;
}

export function FilesList({
  files,
  loading,
  error,
  baseUrl,
  onPreview,
  onDelete,
}: Props) {
  const [confirmDelete, setConfirmDelete] = React.useState<FileEntry | null>(
    null,
  );
  const [systemOpen, setSystemOpen] = React.useState(false);

  if (loading) {
    return (
      <p
        style={{
          color: "var(--t-text-body)",
          fontSize: 12,
          textAlign: "center",
          padding: "16px 0",
        }}
      >
        Loading…
      </p>
    );
  }
  if (error) {
    return (
      <p
        style={{
          color: "var(--t-danger-strong)",
          fontSize: 12,
          textAlign: "center",
          padding: "8px 0",
        }}
      >
        Failed to load.
      </p>
    );
  }
  if (files.length === 0) {
    return (
      <p
        style={{
          color: "var(--t-text-body)",
          fontSize: 12,
          textAlign: "center",
          padding: "16px 0",
        }}
      >
        No files attached.
      </p>
    );
  }

  const userFiles = files.filter((f) => !isSystemFile(f));
  const systemFiles = files.filter((f) => isSystemFile(f));

  function renderFile(f: FileEntry) {
    const url = f.url ?? `${baseUrl}/api/files/${encodeURIComponent(f.name)}`;
    return (
      <FileItem
        key={f.name}
        file={f}
        url={url}
        variant="normal"
        onPreview={(file) => onPreview(file)}
        onDelete={
          onDelete
            ? (file) => {
                setConfirmDelete(file);
                return Promise.resolve();
              }
            : undefined
        }
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* User attachments */}
      {userFiles.map(renderFile)}

      {/* System-captured files (collapsed by default) */}
      {systemFiles.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <button
            onClick={() => setSystemOpen((o) => !o)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "none",
              border: "1px solid var(--t-border)",
              borderRadius: 8,
              padding: "6px 10px",
              width: "100%",
              cursor: "pointer",
              color: "var(--t-text-faint)",
              fontSize: 11,
              fontWeight: 500,
            }}
          >
            <span
              style={{
                fontSize: 10,
                transition: "transform 0.15s",
                transform: systemOpen ? "rotate(90deg)" : "rotate(0deg)",
                display: "inline-block",
              }}
            >
              ▶
            </span>
            <span
              style={{
                background: "var(--t-border)",
                borderRadius: 4,
                padding: "1px 5px",
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              SYSTEM
            </span>
            <span>Captured by Vibeflow ({systemFiles.length})</span>
          </button>
          {systemOpen && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                marginTop: 6,
              }}
            >
              {systemFiles.map(renderFile)}
              <p
                style={{
                  color: "var(--t-text-faint)",
                  fontSize: 10,
                  margin: "2px 0 0",
                  fontStyle: "italic",
                }}
              >
                Baselines captured at annotation time, verify evidence re-captured
                on every verify run — safe to ignore.
              </p>
            </div>
          )}
        </div>
      )}

      {onDelete && (
        <ConfirmModal
          open={confirmDelete !== null}
          message={
            confirmDelete
              ? `Delete "${confirmDelete.name}"? This action cannot be undone.`
              : ""
          }
          onConfirm={() => {
            if (confirmDelete) void onDelete(confirmDelete);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
