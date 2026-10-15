import React from "react";
import { reportKanbanError } from "./error-report.js";

/**
 * React error boundary for the CLI kanban board (ticket 5087f5e3 —
 * previously none existed, so a render crash blanked the board silently).
 * REPORTS through the same client path as window errors, then renders a
 * usable fallback instead of swallowing: the board name, what happened,
 * and both recovery actions (retry in place, full reload). Styling is
 * inline on theme tokens so the fallback paints even if the stylesheet
 * failed to load.
 */
interface State {
  error: Error | null;
}

export class KanbanErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    try {
      void reportKanbanError(error.name || "Error", error.message || "Unknown error", window.location.href);
    } catch {
      /* reporting must never break the fallback */
    }
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  private reload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        data-role="kanban-error-fallback"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          height: "100vh",
          padding: 24,
          background: "var(--t-bg, #0f172a)",
          color: "var(--t-text, #e2e8f0)",
          fontFamily: "Inter, system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          Something went wrong on this board
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--t-text-muted, #94a3b8)",
            maxWidth: 480,
          }}
        >
          {error.name}: {error.message || "Unknown error"}. The error was
          reported — retry below, or reload for a clean state. Your tasks
          are safe.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={this.retry}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "1px solid var(--t-border, #334155)",
              background: "var(--t-accent, #2563eb)",
              color: "#fff",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={this.reload}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: "1px solid var(--t-border, #334155)",
              background: "transparent",
              color: "var(--t-text, #e2e8f0)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Reload board
          </button>
        </div>
      </div>
    );
  }
}
