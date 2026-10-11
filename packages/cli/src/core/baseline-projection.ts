/**
 * Baseline projection contract — the fields a stored baseline must keep.
 *
 * Field projection is the dominant saving when a captured baseline is sent to
 * the backend (raw pair 1,291,311 B -> 395,633 B projected, 3.3x; gzip/brotli
 * take it to ~10 KB / 4.7 KB — see
 * vibeflow-private/docs/research/baseline-compression.md). Projection is only
 * safe if it keeps EXACTLY the fields the consumers read, so this module is
 * the single source of truth for that set: `projectPageSnapshot` /
 * `projectElementSnapshot` build the projected form, and the unit suite
 * (`tests/unit/baseline-projection.test.ts`) fails if a read field is dropped
 * or an unread field creeps in.
 *
 * PAGE projection — precisely the union of fields the CLI consumers read:
 *
 * | projected field          | read by                                                        |
 * | ------------------------ | -------------------------------------------------------------- |
 * | elements[key].after      | verify.ts step-14 backfill, verify-tools readEvidence backfill,|
 * |                          |   diffPageStyles + queryStyleProperty (page-diff.ts)           |
 * | elements[key].selector   | queryStyle page-wide + html_query match labels                 |
 * |                          |   (verify-tools.ts, page-diff.ts)                              |
 * | elements[key].tag        | queryStyleProperty match labels (page-diff.ts)                 |
 * | elements[key].childCount | queryStyleProperty match labels + queryChildChanges            |
 * |                          |   (page-diff.ts), queryStyle page-wide (verify-tools.ts)       |
 * | elements[key].childSignature | queryChildChanges (page-diff.ts)                           |
 * | elements[key].text       | queryTextChanges (page-diff.ts)                                |
 * | elements[key].dataAttrs  | queryAttributeChanges (page-diff.ts)                           |
 * | elements[key].position   | kept per contract. At HEAD no CLI call site dereferences the   |
 * |                          |   PAGE-element position (element_info reads the ELEMENT        |
 * |                          |   baseline position from verify-after.json, not page elements) |
 * |                          |   — but the family contract requires it, so dropping it is a   |
 * |                          |   contract change, not an optimisation.                        |
 * | version / capturedAt /   | structural envelope (see the truncation sibling ticket)        |
 * |   truncated              |                                                                |
 *
 * DROPPED (absent BY DESIGN — verify must tolerate their absence):
 * - elements[key].baseline — redundant: readEvidence back-fills it FROM
 *   .after at read time, as does verify.ts step 14. Storing both style maps
 *   roughly doubles the page payload for zero readers.
 * - elements[key].parentKey — no reader in verify.ts, verify-tools.ts,
 *   page-diff.ts or diff.ts. Nothing reconstructs the tree from storage.
 * - elements[key].classes — no reader on the verify/query path. Style
 *   identity comes from the computed .after maps, never from class lists.
 * - elements[key].key — redundant with the map key of elements[key]. Every
 *   consumer indexes by the map key; the inner copy is never dereferenced.
 *
 * ELEMENT projection (DomSnapshot) — keeps outerHTML, computedStyles,
 * selector, position.{boundingBox,viewport,stackingContext}, browser,
 * consoleErrors, capturedAt. Drops xpath?, parentSnippet? (optional, unread)
 * and position.scrollPosition (only position.boundingBox is diffed; the after
 * position is re-captured live).
 *
 * The local on-disk store stays plain full JSON by owner policy
 * (git-diffable) — this module shapes what may be SENT/STORED remotely, and
 * what verify must accept back. It performs no compression or encoding.
 */

import type { DomSnapshot, PositionContext } from "./verification-types.js";
import type { PageElementRecord, PageSnapshot } from "./page-types.js";

// ── Projected shapes ─────────────────────────────────────────────────────

/** Exactly the page-element fields the consumers read (table above). */
export interface ProjectedPageElement {
  after: Record<string, string> | null;
  selector: string;
  tag: string;
  childCount: number;
  childSignature: string[];
  text: string;
  dataAttrs: Record<string, string>;
  position: { x: number; y: number; width: number; height: number };
}

/**
 * The projected page snapshot. A full PageSnapshot is assignable to this
 * (structural subtyping), so every consumer that accepts the projection also
 * accepts the full capture — but not the reverse.
 */
export interface ProjectedPageSnapshot {
  version: 1;
  capturedAt: string;
  truncated: boolean;
  elements: Record<string, ProjectedPageElement>;
}

/** Element position minus scrollPosition (unread — see module doc). */
export type ProjectedElementPosition = Omit<PositionContext, "scrollPosition">;

/** Element baseline minus xpath/parentSnippet/scrollPosition (all unread). */
export type ProjectedDomSnapshot = Omit<
  DomSnapshot,
  "position" | "xpath" | "parentSnippet"
> & {
  position: ProjectedElementPosition;
};

// ── The contract as data (the unit test pins these) ──────────────────────

/**
 * The projected page-element key set. Sorted in the test and compared
 * EXACTLY against the projection output: a dropped read field or a crept-in
 * unread field fails the suite.
 */
export const PROJECTED_PAGE_ELEMENT_FIELDS = [
  "after",
  "childCount",
  "childSignature",
  "dataAttrs",
  "position",
  "selector",
  "tag",
  "text",
] as const;

export type ProjectedPageElementField =
  (typeof PROJECTED_PAGE_ELEMENT_FIELDS)[number];

/**
 * Fields deliberately absent from the projection, each with the reason.
 * verify tolerates their absence; if a future reader needs one, the
 * projection AND this map AND the test change together.
 */
export const DROPPED_PAGE_ELEMENT_FIELDS: Record<string, string> = {
  baseline:
    "redundant: readEvidence and verify.ts step 14 back-fill element.baseline FROM elements[key].after at read time",
  parentKey:
    "no reader in verify.ts, verify-tools.ts, page-diff.ts or diff.ts — nothing reconstructs the tree from storage",
  classes:
    "no reader on the verify/query path — style identity comes from the computed .after maps, never from class lists",
  key: "redundant with the map key of elements[key] — every consumer indexes by the map key",
};

/** Projected element key set (top level; position sub-keys asserted in test). */
export const PROJECTED_ELEMENT_FIELDS = [
  "browser",
  "capturedAt",
  "consoleErrors",
  "computedStyles",
  "outerHTML",
  "position",
  "selector",
] as const;

// ── Projection ───────────────────────────────────────────────────────────

/** Project a full page snapshot down to the contracted field set. */
export function projectPageSnapshot(
  snapshot: PageSnapshot | ProjectedPageSnapshot,
): ProjectedPageSnapshot {
  const elements: Record<string, ProjectedPageElement> = {};
  for (const [key, el] of Object.entries(snapshot.elements)) {
    elements[key] = {
      after: el.after ?? null,
      selector: el.selector,
      tag: el.tag,
      childCount: el.childCount,
      childSignature: el.childSignature,
      text: el.text,
      dataAttrs: el.dataAttrs,
      position: el.position,
    };
  }
  return {
    version: snapshot.version,
    capturedAt: snapshot.capturedAt,
    truncated: snapshot.truncated,
    elements,
  };
}

/** Project a full element snapshot down to the contracted field set. */
export function projectElementSnapshot(
  snapshot: DomSnapshot | ProjectedDomSnapshot,
): ProjectedDomSnapshot {
  return {
    outerHTML: snapshot.outerHTML,
    computedStyles: snapshot.computedStyles,
    selector: snapshot.selector,
    position: {
      boundingBox: snapshot.position.boundingBox,
      viewport: snapshot.position.viewport,
      stackingContext: snapshot.position.stackingContext,
    },
    browser: snapshot.browser,
    consoleErrors: snapshot.consoleErrors,
    capturedAt: snapshot.capturedAt,
  };
}

// ── Validation (fail loudly, never degrade to undefined) ─────────────────

/** How a baseline artifact failed validation. */
export type BaselineValidationKind = "malformed" | "truncated";

/**
 * A baseline artifact that is present but unusable. Thrown — never converted
 * to a null that a caller could mistake for "no baseline". A silent null is
 * how the truncation bug hid: `?.after` degraded to undefined and the element
 * was quietly skipped.
 */
export class BaselineValidationError extends Error {
  readonly kind: BaselineValidationKind;
  constructor(kind: BaselineValidationKind, message: string) {
    super(message);
    this.name = "BaselineValidationError";
    this.kind = kind;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function malformed(source: string, detail: string): BaselineValidationError {
  return new BaselineValidationError(
    "malformed",
    `${source} is malformed: ${detail}. ` +
      "The artifact is present but unusable — re-annotate to capture a fresh baseline, then re-run verify.",
  );
}

/**
 * Validate an element baseline artifact (baseline.json / verify-after.json /
 * the legacy inline task.baseline). Tolerates the projection's dropped fields
 * (xpath, parentSnippet, scrollPosition are simply not required) but throws on
 * anything the verify path dereferences. Returns the artifact typed as the
 * full snapshot: only the projected subset is guaranteed present, and that
 * subset is exactly what verify dereferences (computeDiff reads outerHTML,
 * computedStyles, position.boundingBox, consoleErrors; verifyTask reads
 * selector, position.viewport/stackingContext, browser, capturedAt).
 */
export function parseDomSnapshot(raw: unknown, source: string): DomSnapshot {
  if (!isRecord(raw)) {
    throw malformed(source, "expected a JSON object");
  }
  if (typeof raw.outerHTML !== "string") {
    throw malformed(source, "missing required string field 'outerHTML'");
  }
  if (!isRecord(raw.computedStyles)) {
    throw malformed(source, "missing required object field 'computedStyles'");
  }
  if (typeof raw.selector !== "string") {
    throw malformed(source, "missing required string field 'selector'");
  }
  if (!isRecord(raw.position)) {
    throw malformed(source, "missing required object field 'position'");
  }
  const position = raw.position;
  if (!isRecord(position.boundingBox)) {
    throw malformed(source, "missing required object 'position.boundingBox'");
  }
  for (const axis of ["x", "y", "width", "height"] as const) {
    if (!isFiniteNumber((position.boundingBox as Record<string, unknown>)[axis])) {
      throw malformed(
        source,
        `position.boundingBox.${axis} must be a finite number`,
      );
    }
  }
  if (!isRecord(position.viewport)) {
    throw malformed(source, "missing required object 'position.viewport'");
  }
  for (const axis of ["width", "height", "dpr"] as const) {
    if (!isFiniteNumber((position.viewport as Record<string, unknown>)[axis])) {
      throw malformed(
        source,
        `position.viewport.${axis} must be a finite number`,
      );
    }
  }
  if (!isRecord(position.stackingContext)) {
    throw malformed(source, "missing required object 'position.stackingContext'");
  }
  if (typeof raw.browser !== "string") {
    throw malformed(source, "missing required string field 'browser'");
  }
  if (!Array.isArray(raw.consoleErrors)) {
    throw malformed(source, "missing required array field 'consoleErrors'");
  }
  if (typeof raw.capturedAt !== "string") {
    throw malformed(source, "missing required string field 'capturedAt'");
  }
  // SAFETY: every field the verify path dereferences was checked above; the
  // remaining DomSnapshot fields (xpath, parentSnippet, scrollPosition) are
  // optional/unread, so a projected artifact is safe under the full type.
  return raw as unknown as DomSnapshot;
}

function assertPageElementShape(
  el: unknown,
  key: string,
  source: string,
  opts: { allowNullAfter: boolean },
): asserts el is PageElementRecord {
  const where = `${source} element '${key}'`;
  if (!isRecord(el)) {
    throw malformed(source, `element '${key}' is not an object`);
  }
  if (el.after === null) {
    if (!opts.allowNullAfter) {
      throw malformed(source, `element '${key}' has a null 'after' style map`);
    }
  } else if (!isRecord(el.after)) {
    throw malformed(where, "missing required object field 'after'");
  }
  if (typeof el.selector !== "string") {
    throw malformed(where, "missing required string field 'selector'");
  }
  if (typeof el.tag !== "string") {
    throw malformed(where, "missing required string field 'tag'");
  }
  if (!isFiniteNumber(el.childCount)) {
    throw malformed(where, "'childCount' must be a finite number");
  }
  if (!Array.isArray(el.childSignature)) {
    throw malformed(where, "missing required array field 'childSignature'");
  }
  if (typeof el.text !== "string") {
    throw malformed(where, "missing required string field 'text'");
  }
  if (!isRecord(el.dataAttrs)) {
    throw malformed(where, "missing required object field 'dataAttrs'");
  }
  if (!isRecord(el.position)) {
    throw malformed(where, "missing required object field 'position'");
  }
  for (const axis of ["x", "y", "width", "height"] as const) {
    if (!isFiniteNumber((el.position as Record<string, unknown>)[axis])) {
      throw malformed(where, `position.${axis} must be a finite number`);
    }
  }
}

function assertPageEnvelope(
  raw: unknown,
  source: string,
): asserts raw is ProjectedPageSnapshot {
  if (!isRecord(raw)) {
    throw malformed(source, "expected a JSON object");
  }
  if ((raw as { version?: unknown }).version !== 1) {
    throw malformed(source, "missing or unsupported 'version' (expected 1)");
  }
  if (typeof (raw as { capturedAt?: unknown }).capturedAt !== "string") {
    throw malformed(source, "missing required string field 'capturedAt'");
  }
  if (typeof (raw as { truncated?: unknown }).truncated !== "boolean") {
    throw malformed(source, "missing required boolean field 'truncated'");
  }
  if (!isRecord((raw as { elements?: unknown }).elements)) {
    throw malformed(source, "missing required object field 'elements'");
  }
}

/**
 * Validate a page BASELINE artifact (baseline-page.json). Tolerates the
 * projection's dropped fields (baseline, parentKey, classes, key are simply
 * not required) but throws on anything the verify/query path dereferences —
 * and on a truncated baseline: a capped subset is not a reference, and
 * comparing against it proves nothing about the elements beyond the cap.
 */
export function parsePageBaseline(
  raw: unknown,
  source: string,
): ProjectedPageSnapshot {
  assertPageEnvelope(raw, source);
  if (raw.truncated === true) {
    throw new BaselineValidationError(
      "truncated",
      `${source} is truncated (truncated:true): the stored baseline is a capped subset, ` +
        "so a diff against it cannot speak for the elements beyond the cap. " +
        "Re-annotate on the full page, then re-run verify.",
    );
  }
  for (const [key, el] of Object.entries(raw.elements)) {
    assertPageElementShape(el, key, source, { allowNullAfter: false });
  }
  return raw;
}

/**
 * Validate a page AFTER artifact (verify-all-styles.json — this run's own
 * capture). Same shape bar two deliberate relaxations: a truncated capture is
 * legitimate here (it travels with an explicit warning, owned by the
 * truncation sibling ticket), and `after` may be null for a removed element.
 */
export function parsePageAfterSnapshot(
  raw: unknown,
  source: string,
): ProjectedPageSnapshot {
  assertPageEnvelope(raw, source);
  for (const [key, el] of Object.entries(raw.elements)) {
    assertPageElementShape(el, key, source, { allowNullAfter: true });
  }
  return raw;
}
