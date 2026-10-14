import React from "react";
import { renderMarkdown } from "./renderMarkdown";

/** Hover-card data for a task ref. Returned by `taskLookup`; kept in one
    place so the editor's mention index and the preview's hover card agree. */
export interface TaskHoverInfo {
  title: string;
  status: string;
}

interface Props {
  markdown: string;
  className?: string;
  style?: React.CSSProperties;
  /** Resolve a task ref to hover-card data WITHOUT a network request.
      When provided, the legacy `GET /api/tasks/:id` hover fetch never
      fires: hits render from the lookup, misses render the `Task <id>`
      fallback. Omit only where the caller has no task list (e.g. the
      standalone file preview) — there the CLI-board fetch remains. */
  taskLookup?: (id: string) => TaskHoverInfo | undefined;
}

export function MarkdownPreview({ markdown, className, style, taskLookup }: Props) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const cacheRef = React.useRef<Record<string, { title: string; status: string }>>({});
  const [hoverPreview, setHoverPreview] = React.useState<{
    id: string;
    title: string;
    status: string;
    x: number;
    y: number;
  } | null>(null);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    function clearPreview() {
      setHoverPreview(null);
    }

    async function handleOver(ev: MouseEvent) {
      const target = ev.target as HTMLElement | null;
      const link = target?.closest("a[data-task-ref]") as HTMLAnchorElement | null;
      if (!link) {
        clearPreview();
        return;
      }

      ev.preventDefault();
      const id = link.getAttribute("data-task-ref");
      if (!id) return;

      const rect = link.getBoundingClientRect();
      const cached = cacheRef.current[id];
      if (cached) {
        setHoverPreview({ id, title: cached.title, status: cached.status, x: rect.left, y: rect.bottom + 6 });
        return;
      }

      if (taskLookup) {
        const hit = taskLookup(id);
        const info = hit ?? { title: `Task ${id}`, status: "unknown" };
        cacheRef.current[id] = info;
        setHoverPreview({ id, title: info.title, status: info.status, x: rect.left, y: rect.bottom + 6 });
        return;
      }
      try {
        const res = await fetch(`/api/tasks/${id}`);
        const data = await res.json() as { title?: string; status?: string };
        const info = {
          title: data.title ?? `Task ${id}`,
          status: data.status ?? "unknown",
        };
        cacheRef.current[id] = info;
        setHoverPreview({ id, title: info.title, status: info.status, x: rect.left, y: rect.bottom + 6 });
      } catch {
        setHoverPreview({ id, title: `Task ${id}`, status: "unknown", x: rect.left, y: rect.bottom + 6 });
      }
    }

    // When a task-ref link is clicked, dispatch a custom event BEFORE the browser
    // changes the URL hash. This lets App.tsx record the current task in the nav
    // history stack so the "back" button can pop back to it.
    function handleRefClick(ev: MouseEvent) {
      const link = (ev.target as HTMLElement | null)?.closest?.("a[data-task-ref]") as HTMLAnchorElement | null;
      if (!link) return;
      const refId = link.getAttribute("data-task-ref");
      if (!refId) return;
      window.dispatchEvent(new CustomEvent("vibeflow-task-ref-click", { detail: { refId } }));
      // The anchor's href="#task-<id>" naturally sets the hash, triggering hashchange in App.
    }

    root.addEventListener("mouseover", handleOver);
    root.addEventListener("mouseleave", clearPreview);
    root.addEventListener("click", handleRefClick);
    return () => {
      root.removeEventListener("mouseover", handleOver);
      root.removeEventListener("mouseleave", clearPreview);
      root.removeEventListener("click", handleRefClick);
    };
  }, [taskLookup]);

  return (
    <div style={{ position: "relative" }}>
      <div
        ref={rootRef}
        className={className}
        style={style}
        // renderMarkdown() HTML-escapes &, <, > before any transformation —
        // no raw user HTML reaches the DOM.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) }} // nosemgrep
      />
      {hoverPreview && (
        <div
          style={{
            position: "fixed",
            left: hoverPreview.x,
            top: hoverPreview.y,
            background: "#0f172a",
            border: "1px solid rgba(59,130,246,0.4)",
            color: "#e2e8f0",
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 11,
            boxShadow: "0 10px 24px rgba(2,6,23,0.55)",
            zIndex: 60,
            pointerEvents: "none",
            minWidth: 180,
          }}
        >
          <div style={{ color: "#60a5fa", fontFamily: "Menlo,monospace", marginBottom: 3 }}>#{hoverPreview.id}</div>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>{hoverPreview.title}</div>
          <div style={{ color: "#94a3b8" }}>status: {hoverPreview.status}</div>
        </div>
      )}
    </div>
  );
}
