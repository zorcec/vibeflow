// ── Source Pointer — Tiered Element-to-Source Resolution ──────────────────────
//
// Implements the resolution strategy from docs/specs/selectors.spec.md v0.2
//
// Resolution tiers (first one yielding data wins for file/line; all tiers run
// for redundancy and the results are merged):
//
//   Tier 1  — Framework internals  (React fiber, Vue instance, Angular, Preact)
//   Tier 2b — V8 direct source     (sync; _debugStack frames pointing to unbundled
//             files — Vite dev mode, Deno, tsx/ts-node; no .js.map fetch)
//   Tier 2  — Sourcemap lookup     (async; resolves _debugStack frames via .js.map)
//   Tier 3a — test-id attribute    (data-testid / data-test / data-cy / id)
//   Tier 3b — CSS selector         (always computed; last-resort identity)
//
// The `selector` field is always present. All other fields are best-effort.

export interface SourcePointer {
  /** CSS selector — always present. */
  selector: string;
  /** Stable test-id value (data-testid / data-test / data-cy / semantic id). */
  test_id?: string;
  /** Best-effort function name from framework debug stacks (React 19). */
  functionName?: string;
  /** Source file path (relative to project root). Tier 1 / Tier 2b / Tier 2. */
  file?: string;
  /** 1-indexed source line. */
  line?: number;
  /** 1-indexed source column. */
  col?: number;
  /** Nearest named component. Framework-dependent. */
  component?: string;
  /** Human-readable display name derived from the best available identity. */
  display: string;
}

// ── Tier 2b types (exported for testing) ─────────────────────────────────────

/** Structured V8 CallSite interface (Chrome / Node.js only). */
export interface V8CallSite {
  getFileName(): string | null | undefined;
  getLineNumber(): number | null | undefined;
  getColumnNumber(): number | null | undefined;
  getFunctionName(): string | null | undefined;
}

// ── Tier 3b: CSS Selector ─────────────────────────────────────────────────────
//
// Deterministic CSS path anchored on the nearest semantic id or data-testid.
// Max depth: 6 levels. Excludes hashed class names. See spec §7.

// Data attributes treated as stable unique identifiers (in priority order).
const STABLE_DATA_ATTRS = [
  "data-testid", "data-test", "data-cy", "data-test-id",
  "data-task-id", "data-id",
];

export function buildCssSelector(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  let depth = 0;

  while (node && node !== document.body && depth < 6) {
    const semId = getSemanticId(node);
    if (semId) {
      parts.unshift(`#${semId}`);
      break;
    }

    let anchorAttr: string | null = null;
    let anchorName: string | null = null;
    for (const attr of STABLE_DATA_ATTRS) {
      const val = node.getAttribute(attr);
      if (val) { anchorAttr = attr; anchorName = val; break; }
    }
    if (anchorAttr && anchorName) {
      parts.unshift(`[${anchorAttr}="${anchorName}"]`);
      break;
    }

    let segment = node.tagName.toLowerCase();

    const stableClasses = Array.from(node.classList)
      .filter(c => !/^[0-9a-f]{5,}/.test(c) && !c.startsWith("vibeflow-"))
      .slice(0, 2);
    if (stableClasses.length > 0) segment += `.${stableClasses.join(".")}`;

    const parent = node.parentElement;
    if (parent) {
      const parentChildren = Array.from(parent.children);
      const siblings = parentChildren.filter(c => c.tagName === node!.tagName);
      if (siblings.length > 1) {
        segment += `:nth-child(${parentChildren.indexOf(node) + 1})`;
      }
    }

    parts.unshift(segment);
    node = node.parentElement;
    depth++;
  }

  return parts.join(" > ");
}

// ── Tier 3a: test-id attribute ────────────────────────────────────────────────

function resolveTestId(el: Element): { attr: string; value: string } | null {
  const attrs = STABLE_DATA_ATTRS;
  let node: Element | null = el;
  while (node && node !== document.body) {
    for (const attr of attrs) {
      const val = node.getAttribute(attr);
      if (val) return { attr, value: val };
    }
    const id = node.getAttribute("id");
    if (id && isSemanticId(id)) return { attr: "id", value: id };
    node = node.parentElement;
  }
  return null;
}

function isSemanticId(id: string): boolean {
  return !/^[0-9a-f-]{8,}$/i.test(id) && !/^\d+$/.test(id);
}

function getSemanticId(el: Element): string | null {
  const id = el.getAttribute("id");
  return id && isSemanticId(id) ? id : null;
}

// ── Tier 1: Framework internals ───────────────────────────────────────────────

interface Tier1Result {
  file?: string;
  line?: number;
  col?: number;
  component?: string;
  functionName?: string;
}

// React (dev mode) — reads _debugSource from the fiber tree.
// React 19+ — extracts component name from _debugStack Error stack string.
// _debugStack.stack contains frames like: "at ComponentName (bundleUrl:line:col)"
// We return the first PascalCase frame that isn't a React internal.
function parseComponentFromReactStack(stack: string): string | null {
  const SKIP = /^(react-stack|jsxDEV|renderWith|Object\.|_callee)/i;
  for (const line of stack.split("\n")) {
    const m = line.match(/^\s*at\s+([A-Z][A-Za-z0-9._$]*)\s+\(/);
    if (m && !SKIP.test(m[1])) return m[1];
  }
  return null;
}

function parseFunctionFromReactStack(stack: string): string | null {
  const SKIP = /^(react-stack|jsxDEV|renderWith|Object\.|_callee)/i;
  for (const line of stack.split("\n")) {
    const m = line.match(/^\s*at\s+([A-Za-z_$][A-Za-z0-9._$]*)\s+\(/);
    if (m && !SKIP.test(m[1])) return m[1];
  }
  return null;
}

function getReactSource(el: Element): Tier1Result | null {
  const fiberKey = Object.keys(el).find(
    k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"),
  );
  if (!fiberKey) return null;

   
  let fiber: any = (el as any)[fiberKey];
  const result: Tier1Result = {};
  let nearestComponent: string | undefined;
  let parentComponent: string | undefined;
  let depth = 0;

  while (fiber && depth < 20) {
    // React ≤17: _debugSource contains file/line/col (only available in dev mode).
    if (fiber._debugSource && !result.file) {
      result.file = fiber._debugSource.fileName as string;
      result.line = fiber._debugSource.lineNumber as number;
      result.col = fiber._debugSource.columnNumber as number;
    }

    // Component name from _debugOwner (React ≤18 and 19).
    if (!result.component) {
      const ownerName =
        (fiber._debugOwner?.type?.displayName as string | undefined) ??
        (fiber._debugOwner?.type?.name as string | undefined);
      if (ownerName && !nearestComponent) {
        nearestComponent = ownerName;
      }

      const ownerParentName =
        (fiber._debugOwner?.return?._debugOwner?.type?.displayName as string | undefined) ??
        (fiber._debugOwner?.return?._debugOwner?.type?.name as string | undefined) ??
        (fiber._debugOwner?._debugOwner?.type?.displayName as string | undefined) ??
        (fiber._debugOwner?._debugOwner?.type?.name as string | undefined);
      if (ownerParentName && ownerParentName !== ownerName && !parentComponent) {
        parentComponent = ownerParentName;
      }
    }

    // React 19: _debugStack is an Error whose .stack contains component frames.
    if (!result.component) {
      const stack = (fiber._debugStack as { stack?: string } | undefined)?.stack;
      if (stack) {
        const name = parseComponentFromReactStack(stack);
        if (name && !nearestComponent) nearestComponent = name;
        const functionName = parseFunctionFromReactStack(stack);
        if (functionName) result.functionName = functionName;
      }
    }

    if ((result.file || result.component) && depth > 0) break;
    fiber = fiber.return;
    depth++;
  }

  if (nearestComponent) {
    result.component = parentComponent ? `${parentComponent} > ${nearestComponent}` : nearestComponent;
  }

  return result.file != null || result.component != null ? result : null;
}

// Vue 3 (dev mode) — reads __vueParentComponent from the DOM node.
function getVue3Source(el: Element): Tier1Result | null {
  let node: Element | null = el;
  while (node) {
     
    const instance = (node as any).__vueParentComponent;
    if (instance) {
      return {
        file: (instance.type?.__file as string | undefined) ?? undefined,
        component:
          (instance.type?.name as string | undefined) ??
          (instance.type?.__name as string | undefined) ??
          undefined,
      };
    }
    node = node.parentElement;
  }
  return null;
}

// Vue 2 (dev mode) — reads __vue__ from the DOM node.
function getVue2Source(el: Element): Tier1Result | null {
  let node: Element | null = el;
  while (node) {
     
    const vm = (node as any).__vue__;
    if (vm) {
      return {
        file: (vm.$options?.__file as string | undefined) ?? undefined,
        component: (vm.$options?.name as string | undefined) ?? undefined,
      };
    }
    node = node.parentElement;
  }
  return null;
}

// Angular (dev mode) — uses ng.getComponent() global.
function getAngularSource(el: Element): Tier1Result | null {
   
  const ng = (window as any).ng;
  if (!ng) return null;
  let node: Element | null = el;
  while (node) {
    try {
      const component = ng.getComponent(node);
      if (component) {
        return {
          component: (component.constructor?.name as string | undefined) ?? undefined,
        };
      }
    } catch {
      // ng.getComponent throws on non-Angular elements
    }
    node = node.parentElement;
  }
  return null;
}

// Preact (dev mode) — reads __P and __k from DOM nodes.
function getPreactSource(el: Element): Tier1Result | null {
   
  const e = el as any;
  const children: unknown[] = e.__P?.__k ?? [];
  // Walk __k to find the first VNode with a named component type
  const GENERIC_NAMES = new Set(["Object", "VNode", "VNode2"]);
  for (const vnode of children) {
    if (!vnode || typeof vnode !== "object") continue;
     
    const v = vnode as any;
    const typeNameRaw = v?.type?.name as string | undefined;
    const ctorNameRaw = v?.constructor?.name as string | undefined;
    const ctorName = ctorNameRaw && !GENERIC_NAMES.has(ctorNameRaw) ? ctorNameRaw : undefined;
    const name = typeNameRaw ?? ctorName ?? undefined;
    if (name) return { component: name };
  }
  // Fallback to preact attribute node
  const attrNode = e.__preactattr__;
  if (!attrNode) return null;
  const typeNameRaw = attrNode?.type?.name as string | undefined;
  return typeNameRaw ? { component: typeNameRaw } : null;
}

function resolveFrameworkSource(el: Element): Tier1Result | null {
  return (
    getReactSource(el) ??
    getVue3Source(el) ??
    getVue2Source(el) ??
    getAngularSource(el) ??
    getPreactSource(el)
  );
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export function buildSourcePointer(element: Element): SourcePointer {
  // Tier 3b — always computed first (CSS selector is the ultimate fallback)
  const cssSelector = buildCssSelector(element);
  const pointer: SourcePointer = { selector: cssSelector, display: cssSelector };

  // Tier 1 — framework internals (highest informational value)
  const tier1 = resolveFrameworkSource(element);
  if (tier1) {
    if (tier1.file != null) pointer.file = tier1.file;
    if (tier1.line != null) pointer.line = tier1.line;
    if (tier1.col != null) pointer.col = tier1.col;
    if (tier1.component != null) pointer.component = tier1.component;
    if (tier1.functionName != null) pointer.functionName = tier1.functionName;
  }

  // Proto-id shortcut (proto-studio specific; highest priority for display + selector)
  const protoId = element.getAttribute("data-vibeflow-id");
  if (protoId) {
    pointer.selector = `[data-vibeflow-id="${protoId}"]`;
    pointer.display = protoId;
    return pointer;
  }

  // Tier 3a — test-id (cheap; collected for redundancy)
  const testIdResult = resolveTestId(element);
  if (testIdResult) {
    pointer.test_id = testIdResult.value;
  }

  // ── Selector priority: source file > component > function > test-id > CSS ──
  // The `selector` field is the primary task identifier stored in the task file.
  // `cssSelector` is sent separately and used for DOM element lookup.
  if (pointer.file) {
    const fileName = pointer.file.replace(/\\/g, "/").split("/").pop() ?? pointer.file;
    pointer.selector = pointer.line != null ? `${pointer.file}:${pointer.line}` : pointer.file;
    pointer.display = pointer.line != null ? `${fileName}:${pointer.line}` : fileName;
  } else if (pointer.component) {
    pointer.selector = pointer.component;
    pointer.display = pointer.component;
  } else if (pointer.functionName) {
    pointer.selector = pointer.functionName;
    pointer.display = pointer.functionName;
  } else if (testIdResult) {
    pointer.selector = testIdResult.attr === "id"
      ? `#${testIdResult.value}`
      : `[${testIdResult.attr}="${testIdResult.value}"]`;
    pointer.display = `${testIdResult.attr}:${testIdResult.value}`;
  }

  return pointer;
}

// ── Tier 2: Source map resolution (async) ────────────────────────────────────
//
// React 18.3+ dropped _debugSource and stores _debugStack (an Error object)
// on each fiber instead. The stack contains bundled chunk URLs with line/col.
// We fetch the Turbopack-generated source map for that chunk and decode the
// VLQ mappings to recover the original source file + line number.

// Minimal VLQ base64 decoder. Each base64 char is: 1 continuation bit (MSB)
// + 5 data bits; first char's bit 0 is the sign bit.
// eslint-disable-next-line no-secrets/no-secrets -- base64 alphabet constant, not a credential
const VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_TABLE: Record<number, number> = {};
for (let i = 0; i < VLQ_CHARS.length; i++) VLQ_TABLE[VLQ_CHARS.charCodeAt(i)] = i;

function vlqDecodeInt(s: string, pos: number): [number, number] {
  let result = 0, shift = 0, byte = 0;
  do {
    byte = VLQ_TABLE[s.charCodeAt(pos++)] ?? 0;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte & 0x20);
  return [(result & 1) ? -(result >> 1) : (result >> 1), pos];
}

function vlqDecodeSegment(seg: string): number[] {
  const out: number[] = [];
  let pos = 0;
  while (pos < seg.length) {
    const [n, next] = vlqDecodeInt(seg, pos);
    out.push(n); pos = next;
  }
  return out;
}

interface RawSourceMap {
  version?: number;
  sources?: string[];
  mappings?: string;
  sourceRoot?: string;
  sections?: Array<{ offset: { line: number; column: number }; map: RawSourceMap }>;
}

interface MappingResult { source: string; line: number; col: number; }

// Walk a flat (non-sectioned) source map to find the original position.
// srcIdx/srcLine/srcCol state accumulates across ALL segments (never reset).
function findFlatMapping(map: RawSourceMap, genLine: number, genCol: number): MappingResult | null {
  if (!map.mappings || !map.sources) return null;
  const lines = map.mappings.split(";");
  let srcIdx = 0, srcLine = 0, srcCol = 0;
  let best: MappingResult | null = null;

  for (let i = 0; i < lines.length; i++) {
    let genColAcc = 0;
    for (const seg of lines[i].split(",")) {
      if (!seg) continue;
      const d = vlqDecodeSegment(seg);
      if (d.length < 1) continue;
      genColAcc += d[0];
      if (d.length >= 4) {
        srcIdx += d[1]; srcLine += d[2]; srcCol += d[3];
        if (i === genLine && genColAcc <= genCol) {
          best = { source: map.sources[srcIdx] ?? "", line: srcLine + 1, col: srcCol + 1 };
        }
        if (i === genLine && genColAcc > genCol) break;
      }
    }
    if (i > genLine) break;
  }
  return best;
}

// Resolve in a potentially-sectioned source map (Turbopack uses sections).
function resolveInMap(map: RawSourceMap, genLine: number, genCol: number): MappingResult | null {
  if (map.sections) {
    let best: (typeof map.sections)[0] | null = null;
    for (const s of map.sections) {
      if (s.offset.line < genLine || (s.offset.line === genLine && s.offset.column <= genCol)) {
        best = s;
      }
    }
    if (!best) return null;
    const relLine = genLine - best.offset.line;
    const relCol = relLine === 0 ? genCol - best.offset.column : genCol;
    return resolveInMap(best.map, relLine, relCol);
  }
  return findFlatMapping(map, genLine, genCol);
}

// Cache: chunk URL → fetch promise for the source map JSON.
const smCache = new Map<string, Promise<RawSourceMap | null>>();

function fetchSourceMap(chunkUrl: string): Promise<RawSourceMap | null> {
  let p = smCache.get(chunkUrl);
  if (!p) {
    p = fetch(`${chunkUrl}.map`)
      .then(r => (r.ok ? r.json() as Promise<RawSourceMap> : null))
      .catch(() => null);
    smCache.set(chunkUrl, p);
  }
  return p;
}

// Patterns that identify non-user frames in _debugStack (bundler/React internals).
const SKIP_FRAME_RE = /node_modules|_next\/dist|react-stack-top-frame|jsxDEV|react_stack_bottom_frame|fakeJSXCallSite|initializeElement/;

// Extract the first user-land frame from a React _debugStack.stack string.
function parseUserFrame(stack: string): { chunkUrl: string; line: number; col: number } | null {
  for (const line of stack.split("\n")) {
    const m = line.match(/at [^(]+ \((https?:\/\/[^)]+):(\d+):(\d+)\)/);
    if (!m) continue;
    const [, url, lineStr, colStr] = m;
    if (!SKIP_FRAME_RE.test(url)) {
      return { chunkUrl: url, line: parseInt(lineStr, 10), col: parseInt(colStr, 10) };
    }
  }
  return null;
}

// Get the _debugStack string from the element's immediate React fiber.
function getDebugStackStr(el: Element): string | null {
  const fiberKey = Object.keys(el).find(
    k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"),
  );
  if (!fiberKey) return null;
   
  const fiber = (el as any)[fiberKey];
  return (fiber?._debugStack as { stack?: string } | undefined)?.stack ?? null;
}

// Clean raw source path / URL to a workspace-relative path.
// Handles: Turbopack virtual prefixes, Docker container paths, Vite dev URLs.
// e.g. "file:///app/apps/web/src/components/Button.tsx" → "apps/web/src/components/Button.tsx"
// e.g. "http://localhost:5173/src/Button.tsx?v=abc" → "/src/Button.tsx"
function cleanSourcePath(raw: string): string {
  return raw
    .replace(/\?.*$/, "")                      // strip Vite ?v=hash query first
    .replace(/^https?:\/\/[^/]+\/@fs/, "")    // Vite @fs virtual route (absolute path)
    .replace(/^https?:\/\/[^/]+/, "")          // strip http://host → relative URL path
    .replace(/^file:\/\/\/app\//, "")          // docker container absolute
    .replace(/^file:\/\/\//, "")               // generic absolute file URL
    .replace(/\[project\]\//g, "")             // Turbopack virtual prefix
    .replace(/%28/g, "(").replace(/%29/g, ")") // URL-decode parens
    .replace(/%20/g, " ");
}

// ── Tier 2b: V8 Error.prepareStackTrace — direct unbundled source extraction ──
//
// For apps running WITHOUT bundling (Vite dev mode, Deno native ESM, tsx/ts-node),
// every module is served as its own file. Stack frames in React's _debugStack
// therefore point directly to the original source URLs — no .js.map fetch needed.
//
// Strategy:
//   1. In V8 environments (Chrome, Node.js), attempt Error.prepareStackTrace to
//      get structured CallSite objects (filename, line, col) before .stack freezes.
//   2. Fall back to regex parsing of the .stack string (works in all browsers).
//   Both paths check whether the resolved URL is a direct source file
//   (ends in .ts/.tsx/.js/.jsx without bundle-chunk patterns).

// Matches .ts/.tsx/.js/.jsx/.mts/.mjs extensions with optional Vite ?v=hash query.
const DIRECT_SRC_EXT_RE = /\.m?[tj]sx?(\?[^)]*)?$/;
// Patterns that identify bundled output files (not individual source modules).
const BUNDLE_CHUNK_RE = /chunk[-_.][0-9a-f]{6,}|\.chunk\.[0-9a-f]|webpack|_next\/(?:static\/chunks|dist)|rollup/i;

/**
 * Returns true when `url` points to an individual source module (not a bundle).
 * Used to detect Vite dev-server / Deno / tsx unbundled stack frames.
 */
export function isDirectSourceUrl(url: string): boolean {
  if (!url) return false;
  if (!DIRECT_SRC_EXT_RE.test(url)) return false;
  if (BUNDLE_CHUNK_RE.test(url)) return false;
  if (SKIP_FRAME_RE.test(url)) return false;
  return true;
}

/**
 * Use V8's Error.prepareStackTrace hook to extract structured CallSite[] from
 * an Error *before* its .stack property is first stringified. Returns null in
 * non-V8 engines (Firefox, Safari) or when .stack was already accessed.
 */
export function captureV8CallSites(err: Error): V8CallSite[] | null {
  if (typeof (Error as any).captureStackTrace !== "function") return null; // non-V8
  const prev = (Error as any).prepareStackTrace as unknown;
  let captured: V8CallSite[] | null = null;
  try {
    (Error as any).prepareStackTrace = (_: Error, sites: V8CallSite[]) => {
      captured = sites;
      // Return a readable string so .stack is cached as a string, not an array.
      return sites
        .map(s => `    at ${s.getFunctionName() ?? "<anonymous>"} (${s.getFileName()}:${s.getLineNumber()}:${s.getColumnNumber()})`)
        .join("\n");
    };
    // Accessing .stack triggers the hook only if it hasn't been computed yet.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    void (err as any).stack;
  } finally {
    (Error as any).prepareStackTrace = prev;
  }
  return captured;
}

// Return the raw _debugStack Error from the element's React fiber without
// accessing .stack (preserves V8 lazy-compute window for captureV8CallSites).
function getDebugStackError(el: Element): Error | null {
  const fiberKey = Object.keys(el).find(
    k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"),
  );
  if (!fiberKey) return null;
  const fiber = (el as any)[fiberKey];
  const ds = fiber?._debugStack;
  return ds instanceof Error ? ds : null;
}

/**
 * Tier 2b — Synchronously resolve source file:line for an element whose
 * _debugStack points to individual unbundled module files (Vite dev, Deno, tsx).
 * No network request: V8 structured CallSites are tried first, then .stack string
 * parsing as a universal fallback.
 */
export function resolveDirectSourceFromStack(
  el: Element,
): { file: string; line: number; col: number; fnName?: string } | null {
  const stackErr = getDebugStackError(el);
  if (!stackErr) return null;

  // V8 path: get structured call sites before .stack is stringified.
  const callSites = captureV8CallSites(stackErr);
  if (callSites) {
    for (const site of callSites) {
      const fileName = site.getFileName?.() ?? null;
      if (!fileName || SKIP_FRAME_RE.test(fileName)) continue;
      if (!isDirectSourceUrl(fileName)) continue;
      return {
        file: cleanSourcePath(fileName),
        line: site.getLineNumber?.() ?? 1,
        col: site.getColumnNumber?.() ?? 1,
        fnName: site.getFunctionName?.() ?? undefined,
      };
    }
  }

  // String fallback: parse .stack for direct source URLs (all browsers).
  const stack = typeof (stackErr as any).stack === "string"
    ? (stackErr as any).stack as string
    : null;
  if (!stack) return null;

  for (const raw of stack.split("\n")) {
    // Match "at FunctionName (url:line:col)" or bare "at url:line:col"
    const m =
      raw.match(/^\s*at [^(]+ \(([^)]+):(\d+):(\d+)\)$/) ??
      raw.match(/^\s*at ((?:https?|file):\/\/[^:]+):(\d+):(\d+)$/);
    if (!m) continue;
    const [, url, lineStr, colStr] = m;
    if (!isDirectSourceUrl(url)) continue;
    if (SKIP_FRAME_RE.test(url)) continue;
    return {
      file: cleanSourcePath(url),
      line: parseInt(lineStr, 10),
      col: parseInt(colStr, 10),
    };
  }

  return null;
}

// Resolve original file + line for an element using _debugStack + source maps.
// Returns null when the stack/map is absent or the position can't be decoded.
export async function resolveSourceFromStack(
  el: Element,
): Promise<{ file: string; line: number; col: number } | null> {
  const stack = getDebugStackStr(el);
  if (!stack) return null;
  const frame = parseUserFrame(stack);
  if (!frame) return null;
  const map = await fetchSourceMap(frame.chunkUrl);
  if (!map) return null;
  // Source maps use 0-indexed lines/cols; stack traces use 1-indexed.
  const mapped = resolveInMap(map, frame.line - 1, frame.col - 1);
  if (!mapped) return null;
  return { file: cleanSourcePath(mapped.source), line: mapped.line, col: mapped.col };
}

// Async variant of buildSourcePointer that enriches the sync result with Tier 2b
// (direct unbundled source) and Tier 2 (source map fetch) when Tier 1 didn't
// yield a file/line.
export async function buildSourcePointerAsync(element: Element): Promise<SourcePointer> {
  const pointer = buildSourcePointer(element);
  if (pointer.file) return pointer; // Tier 1 already had data

  // Tier 2b — direct source extraction (synchronous; no network fetch).
  // Works for Vite dev mode, Deno, tsx/ts-node — unbundled apps where _debugStack
  // frames point directly to individual source files.
  const direct = resolveDirectSourceFromStack(element);
  if (direct) {
    pointer.file = direct.file;
    pointer.line = direct.line;
    pointer.col = direct.col;
    const fileName = direct.file.replace(/\\/g, "/").split("/").pop() ?? direct.file;
    pointer.selector = `${direct.file}:${direct.line}`;
    pointer.display = `${fileName}:${direct.line}`;
    return pointer;
  }

  // Tier 2 — async source map fetch (for bundled apps with .js.map files).
  const resolved = await resolveSourceFromStack(element);
  if (!resolved) return pointer;

  pointer.file = resolved.file;
  pointer.line = resolved.line;
  pointer.col = resolved.col;

  const fileName = resolved.file.replace(/\\/g, "/").split("/").pop() ?? resolved.file;
  pointer.selector = `${resolved.file}:${resolved.line}`;
  pointer.display = `${fileName}:${resolved.line}`;

  return pointer;
}

// ── Plain-text format for agent context (spec §9) ─────────────────────────────

export function formatSourcePointerForAgent(p: SourcePointer): string {
  const lines: string[] = [];
  if (p.file) {
    let src = `Source: ${p.file}`;
    if (p.line != null) src += ` line ${p.line}`;
    if (p.col != null) src += ` col ${p.col}`;
    if (p.component) src += ` (${p.component})`;
    lines.push(src);
  } else if (p.component) {
    lines.push(`Component: ${p.component}`);
  } else if (p.functionName) {
    lines.push(`Function: ${p.functionName}`);
  }
  if (p.test_id) lines.push(`TestID: ${p.test_id}`);
  lines.push(`Selector: ${p.selector}`);
  return lines.join("\n");
}


