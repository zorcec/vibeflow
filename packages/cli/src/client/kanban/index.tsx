import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { configureWasmBaseUrl } from "@vibeflow-tools/ui/kanban";

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
  createRoot(rootEl).render(<App />);
}
