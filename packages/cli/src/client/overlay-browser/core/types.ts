// Type declarations for the browser overlay.

// Re-export shared verification types as single source of truth.
export type {
  PositionContext,
  DomSnapshot,
  AuthState,
  EncryptedAuthState,
  DiffResult,
} from "../../../core/verification-types.js";

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
  /**
   * Agent chat availability (ticket 0847833f): true only when the
   * serving CLI runs with VIBEFLOW_AGENT_CHAT=1 AND a local WS channel
   * exists (local `serve`). SaaS bundles always get false — the agent
   * runs server-side in `serve`, never in the cloud.
   */
  agentChat?: boolean;
}

/** Page-wide DOM snapshot for baseline capture. */
export interface PageSnapshot {
  version: 1;
  capturedAt: string;
  truncated: boolean;
  elements: Record<string, PageElement>;
}

/** Single element in a page-wide snapshot. */
export interface PageElement {
  key: string;
  selector: string;
  tag: string;
  classes: string[];
  dataAttrs: Record<string, string>;
  parentKey: string;
  childCount: number;
  childSignature: string[];
  text: string;
  position: { x: number; y: number; width: number; height: number };
  baseline: Record<string, string>;
  after: Record<string, string>;
}
