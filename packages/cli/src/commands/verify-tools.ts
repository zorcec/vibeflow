import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { getFilesDir } from "../core/files.js";
import {
  queryChildChanges,
  queryTextChanges,
  queryAttributeChanges,
} from "../core/page-diff.js";
import {
  parseDomSnapshot,
  parsePageBaseline,
  parsePageAfterSnapshot,
  BaselineValidationError,
} from "../core/baseline-projection.js";
import type { ProjectedPageSnapshot } from "../core/baseline-projection.js";
import { MAX_ELEMENTS, captureTruncationWarning } from "./verify.js";

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
  // Opaque by design: validated snapshots, cast back to their domain types at
  // each read site (the JSON round-trip strips the static type). Typed as
  // unknown so validated shapes flow in without lossy re-casts.
  position: unknown;
  allStyles: unknown;
  pageBaseline: unknown;
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

  //
  // Strict baseline reads: a MISSING file yields null (the tools then report
  // "run verify first"), but a PRESENT file that does not parse is a broken
  // artifact, not a missing one — throwing beats degrading to null, because a
  // silent null is how the truncation bug hid.
  //
  const readBaselineJson = (
    name: string,
  ): Record<string, unknown> | undefined => {
    const path = join(filesDir, name);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BaselineValidationError(
        "malformed",
        `${name} for task ${taskId} is not valid JSON: ${msg}. Re-run verify to regenerate it.`,
      );
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

  // Element snapshots: missing file -> null (tools report "run verify
  // first"); present file -> strictly validated. A projected baseline
  // (droppable fields absent by design) validates cleanly; anything the
  // tools dereference that is missing or misshapen throws instead of
  // degrading to null.
  const baselineRaw = readBaselineJson("baseline.json");
  const afterRaw = readBaselineJson("verify-after.json");
  const baseline =
    baselineRaw === undefined
      ? null
      : parseDomSnapshot(baselineRaw, `baseline.json for task ${taskId}`);
  const after =
    afterRaw === undefined
      ? null
      : parseDomSnapshot(afterRaw, `verify-after.json for task ${taskId}`);
  const diff = readJson("verify-diff.json");
  const consoleText = readText("verify-console.txt");

  // Page-wide baseline for cross-element queries. Same missing-vs-malformed
  // split: absence means "no page evidence yet", presence means "must be a
  // well-formed snapshot". A truncated stored BASELINE throws (a capped
  // subset is not a reference); the after-capture keeps its explicit warning
  // path downstream and is validated shape-only here.
  const allStylesRaw = readBaselineJson("verify-all-styles.json");
  const baselinePageRaw = readBaselineJson("baseline-page.json");
  const allStyles =
    allStylesRaw === undefined
      ? null
      : parsePageAfterSnapshot(
          allStylesRaw,
          `verify-all-styles.json for task ${taskId}`,
        );
  const baselinePage =
    baselinePageRaw === undefined
      ? null
      : parsePageBaseline(
          baselinePageRaw,
          `baseline-page.json for task ${taskId}`,
        );
  if (allStyles?.elements && baselinePage?.elements) {
    for (const [key, el] of Object.entries(allStyles.elements)) {
      const baselineEl = baselinePage.elements[key];
      if (baselineEl?.after) {
        // SAFETY: the back-filled `baseline` map is exactly what the page-wide
        // style_query reader dereferences (el.baseline?.[property)); the
        // source map was validated as a string record by parsePageBaseline.
        (el as unknown as Record<string, unknown>).baseline =
          baselineEl.after;
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
    const snap = ev.allStyles as unknown as { truncated?: boolean; elements: Record<string, { selector: string; tag: string; childCount: number; baseline: Record<string, string> | null; after: Record<string, string> | null }> };
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
    return {
      ok: true,
      tool: "style_query",
      taskId: ev.taskId,
      property,
      // Propagate the snapshot's real flag: a capped capture means these
      // matches are a partial view of the page.
      truncated: snap.truncated === true,
      matches,
    };
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

  // Task resolution, evidence load, and query dispatch run in the shared
  // `inspectVerificationEvidence` operation (`core/operations/verify.ts`),
  // which owns the one id rule (a UNIQUE prefix resolves; an ambiguous one
  // is refused). This dispatcher keeps the CLI's rendering — usage lines,
  // stdout/stderr shapes, exit codes — byte-identical: tool-level misses
  // travel as data, exactly as the switch below used to produce.
  const { inspectVerificationEvidence } = await import(
    "../core/operations.js"
  );
  const opResult = await inspectVerificationEvidence(
    { projectDir, mode: "local" },
    {
      taskId,
      tool,
      ...(tool === "style_query" ? { property: rest[1] } : {}),
      ...(opts.filter === undefined ? {} : { filter: opts.filter }),
      ...(tool === "html_query" ? { queryType: rest[1] } : {}),
    },
  );

  let result: Record<string, unknown>;
  if (!opResult.ok) {
    // A task that cannot be resolved or evidence that cannot be trusted is
    // a hard tool failure with a nonzero exit, as before. The
    // malformed-evidence shape stays pretty-printed JSON while the
    // not-found shape stays compact — each matches the inline branch the
    // operation replaces.
    const message = opResult.error?.message ?? "Unknown error";
    const failure = { ok: false, error: message };
    if (opts.json) {
      console.log(
        opResult.error?.code === "E_EVIDENCE_MALFORMED"
          ? JSON.stringify(failure, null, 2)
          : JSON.stringify(failure),
      );
    } else {
      process.stderr.write(`✗ ${message}\n`);
    }
    process.exitCode = 1;
    return;
  }
  result = opResult.data as Record<string, unknown>;

  // A truncated capture makes every page-wide result a partial view. Attach the
  // warning to the tool's own output so it cannot be missed alongside the data.
  if ((result as { truncated?: boolean }).truncated === true) {
    result.warning = captureTruncationWarning(MAX_ELEMENTS);
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
// Exported for the shared `inspectVerificationEvidence` operation
// (`core/operations/verify.ts`), which dispatches the same query behind an
// injected evidence loader. No behaviour change: the renderer calls it
// exactly as before.
export function queryHtml(
  ev: EvidenceSet,
  queryType: "children" | "text" | "attributes",
): Record<string, unknown> {
  if (!ev.allStyles) {
    return { ok: false, error: "No verify-all-styles.json found. Run 'vibeflow verify <task-id>' first." };
  }

  // SAFETY: ev.allStyles passed parsePageAfterSnapshot in readEvidence, so it
  // conforms to ProjectedPageSnapshot. The JSON.parse round-trip strips the
  // type, so we cast through unknown to restore it.
  const current = ev.allStyles as unknown as ProjectedPageSnapshot;
  // Use the page baseline from baseline-page.json if available.
  // This is the annotation-time capture that serves as the ground truth.
  // SAFETY: ev.pageBaseline passed parsePageBaseline in readEvidence, so it
  // conforms to ProjectedPageSnapshot (droppable fields absent by design).
  const baseline: ProjectedPageSnapshot = ev.pageBaseline
    ? (ev.pageBaseline as unknown as ProjectedPageSnapshot)
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
