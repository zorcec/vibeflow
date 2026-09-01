import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { getFilesDir } from "../core/files.js";
import { findTaskFilePath } from "../core/tasks.js";
import type { PageSnapshot } from "../core/page-types.js";
import {
  queryChildChanges,
  queryTextChanges,
  queryAttributeChanges,
} from "../core/page-diff.js";

// ── Tool set ─────────────────────────────────────────────────────────────
export const VERIFY_TOOLS = new Set([
  "style_query",
  "style_diff",
  "element_info",
  "html_diff",
  "html_query",
]);

// ── Evidence set (files that storeEvidence already wrote) ─────────────────
export interface EvidenceSet {
  taskId: string;
  baseline: Record<string, string> | null;
  after: Record<string, string> | null;
  diff: Record<string, [string, string]> | null;
  consoleText: string | null;
  baselineHtml: string | null;
  afterHtml: string | null;
  selector: string | null;
  position: Record<string, unknown> | null;
  allStyles: Record<string, unknown> | null;
  pageBaseline: Record<string, unknown> | null;
}

// ── Read evidence from disk ──────────────────────────────────────────────
export async function readEvidence(
  projectDir: string,
  taskId: string,
): Promise<EvidenceSet> {
  const filesDir = getFilesDir(projectDir, taskId);

  const readJson = (name: string) => {
    const path = join(filesDir, name);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  };

  const readText = (name: string) => {
    const path = join(filesDir, name);
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  };

  const baseline = readJson("baseline.json");
  const after = readJson("verify-after.json");
  const diff = readJson("verify-diff.json");
  const consoleText = readText("verify-console.txt");

  // Page-wide baseline for cross-element queries
  const allStyles = readJson("verify-all-styles.json");
  const baselinePage = readJson("baseline-page.json");
  if (allStyles?.elements && baselinePage?.elements) {
    for (const [key, el] of Object.entries(allStyles.elements)) {
      const baselineEl = baselinePage.elements[key];
      if (baselineEl?.after) {
        (el as Record<string, unknown>).baseline = baselineEl.after;
      }
    }
  }

  return {
    taskId,
    baseline: baseline?.computedStyles ?? null,
    after: after?.computedStyles ?? null,
    diff: diff?.stylesChanged ?? null,
    consoleText,
    baselineHtml: baseline?.outerHTML ?? null,
    afterHtml: after?.outerHTML ?? null,
    selector: after?.selector ?? null,
    position: after?.position ?? null,
    allStyles,
    pageBaseline: baselinePage,
  };
}

// ── Tool: style_query ────────────────────────────────────────────────────
export function queryStyle(
  ev: EvidenceSet,
  property: string,
): Record<string, unknown> {
  // Page-wide mode: search across all elements
  if (ev.allStyles) {
    // SAFETY: ev.allStyles is loaded from verify-all-styles.json which is written by
    // the inline capturePageSnapshot() in verify.ts and conforms to PageSnapshot.
    // The JSON.parse round-trip strips the type, so we cast through unknown to restore it.
    const snap = ev.allStyles as unknown as { elements: Record<string, { selector: string; tag: string; childCount: number; baseline: Record<string, string> | null; after: Record<string, string> | null }> };
    const matches: Array<{ selector: string; tag: string; childCount: number; from: string; to: string; isRelevant: boolean }> = [];
    for (const [, el] of Object.entries(snap.elements)) {
      const baseVal = el.baseline?.[property] ?? null;
      const afterVal = el.after?.[property] ?? null;
      if (baseVal !== afterVal && (baseVal !== null || afterVal !== null)) {
        matches.push({
          selector: el.selector,
          tag: el.tag,
          childCount: el.childCount,
          from: baseVal ?? "(not set)",
          to: afterVal ?? "(not set)",
          isRelevant: Boolean(
            (baseVal === "hidden" && afterVal === "auto") ||
            (baseVal === "visible" && afterVal === "auto") ||
            (baseVal === "line-through" && afterVal === "none") ||
            (baseVal === "none" && afterVal && afterVal !== "none"),
          ),
        });
      }
    }
    return { ok: true, tool: "style_query", taskId: ev.taskId, property, matches };
  }

  // Legacy single-element mode
  if (!ev.after) {
    return { ok: false, error: "No verify-after.json found. Run 'vibeflow verify <task-id>' first." };
  }
  const baselineVal = ev.baseline?.[property] ?? ev.baseline?.[toKebab(property)] ?? null;
  const afterVal = ev.after?.[property] ?? ev.after?.[toKebab(property)] ?? null;
  const changed =
    ev.diff?.[property] !== undefined || ev.diff?.[toKebab(property)] !== undefined;
  return {
    ok: true,
    tool: "style_query",
    taskId: ev.taskId,
    property,
    baseline: baselineVal,
    after: afterVal,
    changed,
  };
}

// ── Tool: style_diff ─────────────────────────────────────────────────────
export function diffStyles(
  ev: EvidenceSet,
  filter?: string,
): Record<string, unknown> {
  if (!ev.diff) {
    return { ok: false, error: "No verify-diff.json found. Run 'vibeflow verify <task-id>' first." };
  }
  const entries = Object.entries(ev.diff);
  const filtered = filter
    ? entries.filter(([key]) => key.toLowerCase().includes(filter.toLowerCase()))
    : entries;
  const styles = Object.fromEntries(filtered);
  return {
    ok: true,
    tool: "style_diff",
    taskId: ev.taskId,
    filter: filter ?? null,
    total: entries.length,
    matched: filtered.length,
    styles,
  };
}

// ── Tool: element_info ───────────────────────────────────────────────────
export function elementInfo(ev: EvidenceSet): Record<string, unknown> {
  if (!ev.after) {
    return { ok: false, error: "No verify-after.json found. Run 'vibeflow verify <task-id>' first." };
  }
  const hasErrors =
    ev.consoleText &&
    !ev.consoleText.includes("no console errors") &&
    ev.consoleText.trim().length > 0;
  return {
    ok: true,
    tool: "element_info",
    taskId: ev.taskId,
    selector: ev.selector,
    position: ev.position,
    consoleErrors: hasErrors
      ? ev.consoleText!.split("\n").filter(Boolean)
      : [],
  };
}

// ── Tool: html_diff ──────────────────────────────────────────────────────
export function htmlDiff(ev: EvidenceSet): Record<string, unknown> {
  if (!ev.afterHtml) {
    return { ok: false, error: "No after HTML found. Run 'vibeflow verify <task-id>' first." };
  }
  const changed = ev.baselineHtml !== ev.afterHtml;
  return {
    ok: true,
    tool: "html_diff",
    taskId: ev.taskId,
    htmlChanged: changed,
    baselineChars: ev.baselineHtml?.length ?? 0,
    afterChars: ev.afterHtml?.length ?? 0,
    baselineHtml: ev.baselineHtml,
    afterHtml: ev.afterHtml,
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────────
export async function runVerifyTool(
  dir: string,
  tool: string,
  rest: string[],
  opts: { json?: boolean; filter?: string } = {},
): Promise<void> {
  const projectDir = resolve(dir);
  const taskId = rest[0];

  if (!taskId) {
    const msg = `Usage: vibeflow verify ${tool} <task-id> ${tool === "style_query" ? "<property>" : ""}`;
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      process.stderr.write(`✗ ${msg}\n`);
    }
    process.exitCode = 1;
    return;
  }

  // Validate task exists
  const taskFilePath = findTaskFilePath(projectDir, taskId);
  if (!taskFilePath) {
    const msg = `Task not found: ${taskId}`;
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      process.stderr.write(`✗ ${msg}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const ev = await readEvidence(projectDir, taskId);
  let result: Record<string, unknown>;

  switch (tool) {
    case "style_query": {
      const prop = rest[1];
      if (!prop) {
        const msg = `Usage: vibeflow verify style_query <task-id> <property>`;
        result = { ok: false, error: msg };
        break;
      }
      result = queryStyle(ev, prop);
      break;
    }
    case "style_diff":
      result = diffStyles(ev, opts.filter);
      break;
    case "element_info":
      result = elementInfo(ev);
      break;
    case "html_diff":
      result = htmlDiff(ev);
      break;
    case "html_query": {
      const queryType = rest[1];
      if (!queryType || !(["children", "text", "attributes"] as const).includes(queryType as "children" | "text" | "attributes")) {
        result = { ok: false, error: `Usage: vibeflow verify html_query <task-id> children|text|attributes` };
        break;
      }
      result = queryHtml(ev, queryType as "children" | "text" | "attributes");
      break;
    }
    default:
      result = { ok: false, error: `Unknown tool: ${tool}` };
      break;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Human-readable output
    if (!result.ok) {
      process.stderr.write(`✗ ${(result as Record<string, string>).error}\n`);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
  }
}

// ── Tool: html_query (page-wide structural diff) ────────────────────────
function queryHtml(
  ev: EvidenceSet,
  queryType: "children" | "text" | "attributes",
): Record<string, unknown> {
  if (!ev.allStyles) {
    return { ok: false, error: "No verify-all-styles.json found. Run 'vibeflow verify <task-id>' first." };
  }

  // SAFETY: ev.allStyles is loaded from verify-all-styles.json which is written by
  // capturePageSnapshot() and conforms to PageSnapshot. The JSON.parse round-trip
  // strips the type, so we cast through unknown to restore it.
  const current = ev.allStyles as unknown as PageSnapshot;
  // Use the page baseline from baseline-page.json if available.
  // This is the annotation-time capture that serves as the ground truth.
  // SAFETY: ev.pageBaseline is loaded from baseline-page.json which is written by
  // capturePageSnapshot() in the overlay and conforms to PageSnapshot.
  const baseline: PageSnapshot = ev.pageBaseline
    ? (ev.pageBaseline as unknown as PageSnapshot)
    : { version: 1, capturedAt: current.capturedAt, truncated: false, elements: {} };

  let result;
  switch (queryType) {
    case "children":
      result = queryChildChanges(baseline, current);
      break;
    case "text":
      result = queryTextChanges(baseline, current);
      break;
    case "attributes":
      result = queryAttributeChanges(baseline, current);
      break;
  }

  return {
    ok: true,
    tool: "html_query",
    taskId: ev.taskId,
    ...result,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────
function toKebab(s: string): string {
  return s.replace(/([A-Z])/g, "-$1").toLowerCase();
}
