import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { configureWasmBaseUrl } from "@vibeflow-tools/ui/kanban";
import { installKanbanErrorReporting } from "./error-report.js";
import { KanbanErrorBoundary } from "./error-boundary.js";

// Ticket 5087f5e3: window error + unhandledrejection forwarding, installed
// before first render so even boot crashes report. The server enforces the
// telemetry flag; the boundary below renders a usable fallback.
installKanbanErrorReporting();

// Image-ingest wasm (lazy: bytes fetch on first transform only). Same
// origin — the CLI server exposes `/__vibeflow__/codecs`. Never throws;
// without it uploads keep raw bytes with true extensions.
try {
  configureWasmBaseUrl(`${window.location.origin}/__vibeflow__/codecs`);
} catch {
  /* unconfigured — graceful fallback in the transform */
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <KanbanErrorBoundary>
      <App />
    </KanbanErrorBoundary>,
  );
}
