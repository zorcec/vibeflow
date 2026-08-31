import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { getFilesDir } from "../core/files.js";
import { findTaskFilePath, readTaskFile } from "../core/tasks.js";

// ── Tool set ─────────────────────────────────────────────────────────────
export const VERIFY_TOOLS = new Set([
  "style_query",
  "style_diff",
  "element_info",
  "html_diff",
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
  };
}

// ── Tool: style_query ────────────────────────────────────────────────────
export function queryStyle(
  ev: EvidenceSet,
  property: string,
): Record<string, unknown> {
  if (!ev.after) {
    return { ok: false, error: "No verify-after.json found. Run 'vibeflow verify <task-id>' first." };
  }
  // Resolve kebab-case from camelCase (e.g. backgroundColor → background-color)
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

// ── Helpers ──────────────────────────────────────────────────────────────
function toKebab(s: string): string {
  return s.replace(/([A-Z])/g, "-$1").toLowerCase();
}
