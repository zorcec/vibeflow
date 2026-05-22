import { fetchTasks } from "./api.js";
import { toggleOverlaySidebar, closeOverlaySidebar } from "../overlay-react/OverlayApp.js";

// ── Sidebar state bridge ───────────────────────────────────────────────────────
// The sidebar and corner trigger UI are now rendered by React (OverlayApp.tsx).
// This module keeps the same public API for backwards compatibility with events.ts.

export function createSidebar(): void {
  // No-op: sidebar is now created by React
}

export function toggleSidebar(): void {
  toggleOverlaySidebar();
  void fetchTasks();
}

export function refreshSidebar(): void {
  // No-op: React re-renders on state update via updateOverlay()
}

// Showcase: overlay-showcase.html → [data-vibeflow-id="showcase-corner-trigger"]
export function setupCornerTrigger(): void {
  // No-op: corner trigger is now rendered by React OverlayApp
}

export function updateCornerTriggerBadge(): void {
  // No-op: badge count is computed from tasks in React OverlayApp
}

// Expose close for Escape key usage in events.ts
export { closeOverlaySidebar as closeSidebar };
