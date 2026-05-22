// React development quality levels for annotation context enrichment.
export type ReactQualityLevel = 'full' | 'partial' | 'none' | 'not-react';

/**
 * Detects whether the current page is a React app and what quality of
 * development context is available for annotations.
 *
 * Quality levels:
 * - 'full'      — React dev mode with _debugSource (≤18.2) or _debugStack (18.3+) →
 *                 component name + source file + line (via source maps if needed)
 * - 'partial'   — React dev mode with _debugOwner only → component name, no file/line
 * - 'none'      — React detected but production build → DOM selectors only
 * - 'not-react' — No React detected (other framework or plain HTML)
 *
 * Detection method: inspect React fiber keys on DOM elements (zero dependencies).
 */
export function detectReactQuality(root: Document | Element = document): ReactQualityLevel {
  const sampleElements = Array.from(root.querySelectorAll('*')).slice(0, 50);

  let hasReact = false;
  let hasDebugSource = false;
  let hasDebugOwner = false;

  for (const elem of sampleElements) {
    for (const key of Object.keys(elem)) {
      if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactInternalInstance')) continue;
      hasReact = true;
       
      const fiber = (elem as any)[key];
      // React ≤18.2: _debugSource directly available
      if (fiber?._debugSource) { hasDebugSource = true; break; }
      // React 18.3+: _debugStack is an Error with bundled chunk URLs;
      // source maps are fetched async to resolve original file/line.
      if (fiber?._debugStack) { hasDebugSource = true; break; }
      if (fiber?._debugOwner) hasDebugOwner = true;
    }
    if (hasDebugSource) break;
  }

  if (!hasReact) return 'not-react';
  if (hasDebugSource) return 'full';
  if (hasDebugOwner) return 'partial';
  return 'none';
}
