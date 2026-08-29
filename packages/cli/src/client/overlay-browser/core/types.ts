// Type declarations for the browser overlay.

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "backlog" | "todo" | "in-progress" | "review" | "done";
  selector: string;
  cssSelector?: string;
  url?: string;
  file?: string;
  line?: number;
  col?: number;
  component?: string;
  type?: string;
  priority?: string;
  created: string;
  updated?: string;
}

export interface TaskGroup {
  [selector: string]: Task[];
}

export interface ProtoConfig {
  port: number;
  wsUrl: string;
  apiUrl: string;
  pagesUrl: string;
  boardId?: string;
  overlayApiKey?: string;
}

// ── Visual Verification Loop (spec §6, §6.1) ─────────────────────────────

/** Element position context captured at annotation time (spec §6.1). */
export interface PositionContext {
  boundingBox: { x: number; y: number; width: number; height: number };
  scrollPosition: { x: number; y: number };
  viewport: { width: number; height: number; dpr: number };
  stackingContext: {
    zIndex: string;
    position: string; // static | relative | absolute | fixed | sticky
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
