/**
 * Types for the page-wide verify query system.
 * Captures ALL elements' styles and HTML, then lets agents query by property/structure.
 */

/** A single element's record in the page snapshot */
export interface PageElementRecord {
  /** DOM-path key (e.g. "0/1/3") */
  key: string;
  /** Human-readable selector (e.g. "div.column-scroll[data-status=backlog]") */
  selector: string;
  tag: string;
  classes: string[];
  dataAttrs: Record<string, string>;
  /** Keystrokes-only parent path (for tree reconstruction) */
  parentKey: string;
  childCount: number;
  /** Compact child summary: ["div.card ×8", "div.hidden-count ×1"] */
  childSignature: string[];
  /** First 200 chars of visible text */
  text: string;
  position: { x: number; y: number; width: number; height: number };
  /** Computed baseline styles (only RELEVANT_STYLES subset, or null if not captured) */
  baseline: Record<string, string> | null;
  /** Computed post-verify styles (or null if element was removed) */
  after: Record<string, string> | null;
}

/** Full snapshot of the page — one per verify run */
export interface PageSnapshot {
  version: 1;
  capturedAt: string;
  /** true when MAX_ELEMENTS was exceeded and results were truncated */
  truncated: boolean;
  elements: Record<string, PageElementRecord>;
}

/** A single style change across the page */
export interface PageStyleChange {
  key: string;
  selector: string;
  prop: string;
  from: string;
  to: string;
}

/** HTML structure diff for a single element */
export interface PageHtmlDiff {
  childCount: { from: number; to: number };
  removed: Array<{ key: string; selector: string; signature: string }>;
  kept: Array<{ key: string; selector: string }>;
  textChanged: boolean;
  attributeChanges: Record<string, { from: string; to: string }>;
}

/** Result of style_diff (summary) */
export interface StyleDiffResult {
  total: number;
  elementCount: number;
  truncated: boolean;
  topChanges: Array<{ prop: string; elements: number }>;
}

/** Result of style_query (filtered by property) */
export interface StyleQueryResult {
  prop: string;
  matches: Array<{
    selector: string;
    tag: string;
    childCount: number;
    from: string;
    to: string;
    isRelevant: boolean;
  }>;
}

/** Result of html_query children/text/attributes */
export interface HtmlQueryResult {
  queryType: "children" | "text" | "attributes";
  matches: Array<{
    selector: string;
    details: string;
  }>;
}
