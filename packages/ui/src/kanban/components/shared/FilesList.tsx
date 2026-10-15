import React from "react";
import type { FileEntry } from "../../types";
import { ConfirmModal } from "../ConfirmModal";
import { FileItem } from "./FileItem";

/** System files: engine-written baselines and verify evidence, flagged by the server at write time. User files: everything else. */
function isSystemFile(f: FileEntry): boolean {
  return f.system === true;
}

/**
 * Non-interactive ghost of a file that is being processed/uploaded right now.
 * Same row geometry as the FileItem normal variant (icon + name + right-side
 * status), dashed outline so it reads as not-yet-stored, and the shared
 * `.spinner` from kanban.css — no new loading language is invented.
 * The `image` flag is caller-supplied MIME knowledge, never a filename
 * match (this file must not sniff extensions — see files-no-regex-guard).
 */
function PendingFileTile({ name, image }: { name: string; image: boolean }) {
  return (
    <div
      className="file-pending"
      title={`Processing "${name}"…`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: 8,
        borderRadius: 8,
        border: "1px dashed var(--t-border)",
        opacity: 0.85,
      }}
    >
      <span style={{ fontSize: 18, flexShrink: 0 }}>{image ? "\u{1F5BC}\uFE0F" : "\u{1F4CE}"}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--t-text)",
            margin: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={name}
        >
          {name}
        </p>
        <p style={{ fontSize: 10, color: "var(--t-text-faint)", margin: 0 }}>
          {image ? "Processing pasted image…" : "Processing file…"}
        </p>
      </div>
      <span className="spinner" aria-label="processing" />
    </div>
  );
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
  /**
   * Files currently being processed/uploaded (paste → wasm transform →
   * upload). Rendered as non-interactive pending tiles ABOVE every state —
   * loading, error, empty, or list — so the wait is visible immediately on
   * paste and the tile clears exactly when the stored file renders.
   * `image` is caller-supplied MIME knowledge, never a filename match.
   */
  pendingFiles?: { name: string; image: boolean }[];
}

export function FilesList({
  files,
  loading,
  error,
  baseUrl,
  onPreview,
  onDelete,
  pendingFiles = [],
}: Props) {
  const [confirmDelete, setConfirmDelete] = React.useState<FileEntry | null>(
    null,
  );
  const [systemOpen, setSystemOpen] = React.useState(false);

  // Pending tiles render above EVERY state below: the tile must already be
  // visible while the list is (re)loading, and must survive an error/empty
  // list so a failed upload still shows what never arrived.
  const pendingTiles =
    pendingFiles.length > 0 ? (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          marginBottom:
            loading || error || files.length === 0 ? 6 : 0,
        }}
      >
        {pendingFiles.map((p) => (
          <PendingFileTile key={p.name} name={p.name} image={p.image} />
        ))}
      </div>
    ) : null;

  // Stale-while-revalidate (fa0d3d0e): a refetch must never blank rows the
  // customer already sees (same contract as the activity feed). The full
  // Loading/Failed states render only when there is nothing to keep.
  const hasRows = files.length > 0 || pendingFiles.length > 0;
  if (loading && !hasRows) {
    return (
      <>
        {pendingTiles}
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
      </>
    );
  }
  if (error && !hasRows) {
    return (
      <>
        {pendingTiles}
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
      </>
    );
  }
  if (files.length === 0 && pendingFiles.length === 0) {
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
      {/* In-flight pastes/uploads — visible until the stored file renders. */}
      {pendingTiles}
      {/* Refresh state stays inline: saved rows are never blanked (fa0d3d0e). */}
      {(loading || (error && hasRows)) && (
        <p
          id={loading ? "dp-files-updating" : "dp-files-stale"}
          style={{ color: loading ? "var(--t-text-faint)" : "var(--t-danger-strong)", fontSize: 10, textAlign: "center", padding: "2px 0" }}
        >
          {loading ? "Updating…" : "Couldn\u2019t refresh — showing saved files."}
        </p>
      )}
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
