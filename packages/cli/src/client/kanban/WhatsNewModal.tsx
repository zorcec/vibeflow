import React from "react";
import { ModalBase, MarkdownPreview } from "@vibeflow-tools/ui/kanban";
import {
  fullChangelogMarkdown,
  pickWhatsNewSection,
  whatsNewMarkdown,
  type ChangelogSection,
} from "./whats-new.js";

interface Props {
  open: boolean;
  sections: ChangelogSection[];
  /** Running CLI version — its section is highlighted; falls back to latest. */
  version: string;
  /** Which view to show when the modal opens. */
  startMode: "whatsnew" | "full";
  onClose: () => void;
}

/**
 * "What's New" changelog modal. Shows the changelog section for the version
 * the user just updated to, with a toggle to browse the full changelog.
 */
export function WhatsNewModal({ open, sections, version, startMode, onClose }: Props) {
  const [mode, setMode] = React.useState<"whatsnew" | "full">(startMode);
  React.useEffect(() => {
    if (open) setMode(startMode);
  }, [open, startMode]);

  const section = React.useMemo(
    () => pickWhatsNewSection(sections, version),
    [sections, version],
  );
  const markdown =
    mode === "full" ? fullChangelogMarkdown(sections) : whatsNewMarkdown(section);

  return (
    <ModalBase
      open={open}
      onClose={onClose}
      id="whats-new-modal"
      width="min(680px, 95vw)"
      maxHeight="80vh"
      title={mode === "full" ? "Changelog" : `What's new in Vibeflow`}
      headerActions={
        <button
          id="whats-new-toggle"
          onClick={() => setMode((m) => (m === "full" ? "whatsnew" : "full"))}
          style={{
            fontSize: 12,
            color: "#60a5fa",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {mode === "full" ? "What's new" : "View full changelog"}
        </button>
      }
      footer={
        <button
          id="whats-new-close"
          onClick={onClose}
          style={{
            padding: "7px 16px",
            borderRadius: 8,
            background: "#2563eb",
            border: "none",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {mode === "full" ? "Close" : "Got it"}
        </button>
      }
    >
      <div
        style={{
          padding: "14px 18px",
          overflowY: "auto",
          flex: 1,
          minHeight: 0,
          fontSize: 13,
          color: "var(--p-text-f)",
        }}
      >
        <MarkdownPreview markdown={markdown} />
      </div>
    </ModalBase>
  );
}
