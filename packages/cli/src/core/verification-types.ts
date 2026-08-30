// ── Shared verification types (§6, §6.1, §7, §9.3) ────────────────────────
// Single source of truth for types shared between CLI (Node.js) and overlay (browser IIFE bundle).
// Pure type definitions — NO runtime dependencies, NO Node.js imports.

/** Element position context captured at annotation time (spec §6.1). */
export interface PositionContext {
  boundingBox: { x: number; y: number; width: number; height: number };
  scrollPosition: { x: number; y: number };
  viewport: { width: number; height: number; dpr: number };
  stackingContext: {
    zIndex: string;
    position: string;
    parentZIndex?: string;
  };
}

/** DOM snapshot captured at annotation time (spec §6). */
export interface DomSnapshot {
  outerHTML: string;
  computedStyles: Record<string, string>;
  selector: string;
  xpath?: string;
  position: PositionContext;
  parentSnippet?: string;
  browser: string;
  consoleErrors: string[];
  capturedAt: string;
}

/** Browser auth state captured at verify mode activation (spec §7.1). */
export interface AuthState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

/** Encrypted auth state stored per-task (spec §7.2). */
export interface EncryptedAuthState {
  version: number;
  createdAt: string;
  expiresAt: string;
  iv: string;
  tag: string;
  data: string;
}

/** Result of computing the structural diff between baseline and after snapshots (§9.3). */
export interface DiffResult {
  /** Did the selector find an element? */
  selectorResolves: boolean;
  /** Did outerHTML change? */
  htmlChanged: boolean;
  /** Per-property computed style changes: { prop: [baseline, after] } */
  stylesChanged: Record<string, [string, string]>;
  /** Did the bounding box shift? */
  positionChanged: boolean;
  /** New console errors that weren't in the baseline */
  newConsoleErrors: string[];
}
