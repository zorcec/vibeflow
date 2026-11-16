/**
 * Real-device mobile viewport (Add Task / Cancel footer invisible).
 *
 * WHAT: on a real Android phone (Chrome and Firefox) the detail panel's
 * footer — Cancel + Add Task in create mode — never rendered, while desktop
 * DevTools device emulation looked fine.
 *
 * WHY (two compounding causes, neither reproducible in DevTools):
 *   1. `100vh` / `height: 100%` on the root resolve against the LARGE
 *      viewport. With the URL bar visible the layout is taller than the
 *      visible area, so the panel (absolute top:0/bottom:0) extends below
 *      the fold and its `flex-shrink: 0` footer hides behind the browser
 *      chrome — unreachable, since everything is `overflow: hidden`.
 *      DevTools emulation never shows the dynamic toolbar.
 *   2. The create-mode title input autofocuses, opening the OS keyboard.
 *      Without `interactive-widget=resizes-content` the keyboard covers the
 *      visual viewport bottom instead of shrinking the layout — exactly
 *      where the footer lives. DevTools never shows the OS keyboard.
 *
 * FIX: `100dvh` sizing (vh fallback) for the root + popovers, a shell
 * viewport meta with `viewport-fit=cover, interactive-widget=resizes-content`,
 * and a narrow-viewport footer reflow (no 360px floor, wrap, safe-area
 * padding, 36px touch targets).
 */
import { describe, it, expect } from "vitest";
import { getKanbanHtml } from "../../../src/server/kanban-template.js";
import { KANBAN_CSS } from "../../../src/server/kanban-css.gen.js";

const MOBILE_VIEWPORT_META =
  "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content";

describe("kanban shell — mobile viewport contract", () => {
  it("production shell resizes content for the on-screen keyboard", () => {
    const html = getKanbanHtml({ port: 3799 });
    expect(html).toContain(
      `<meta name="viewport" content="${MOBILE_VIEWPORT_META}">`,
    );
  });

  it("dev shell carries the same mobile viewport contract", () => {
    const html = getKanbanHtml({ port: 3799, dev: true });
    expect(html).toContain(
      `<meta name="viewport" content="${MOBILE_VIEWPORT_META}">`,
    );
  });
});

describe("kanban CSS — footer stays on real-device viewports", () => {
  it("tracks the dynamic (visible) viewport height, with vh fallback", () => {
    // Root chain: html + body.h-screen (out-specifies the Tailwind
    // h-screen utility) + #root max-height guard.
    //
    // Asserted as CONTRACT, not as minifier output. The previous assertions
    // required the literal `height:100vh;height:100dvh`, which only held under
    // the Tailwind v3 pipeline: Lightning CSS (v4) treats the second declaration
    // as redundant for its default targets and DELETED `100vh` entirely — the
    // fallback was silently gone while the assertion was merely reformatted.
    // The source now uses `@supports (height: 100dvh)`, which cannot be folded,
    // so both halves stay asserted here.
    expect(KANBAN_CSS).toContain("height:100vh");
    expect(KANBAN_CSS).toContain("@supports (height:100dvh)");
    expect(KANBAN_CSS).toContain("max-height:100vh");
  });

  it("clamps popovers to the dynamic viewport, with vh fallback", () => {
    // Same reason as above: Lightning CSS folds `calc()` inside `min()`
    // (`min(calc(100dvh - 130px),840px)` -> `min(100dvh - 130px,840px)`), which
    // is spec-equivalent. Assert the measurement, not the wrapper.
    expect(KANBAN_CSS).toContain("100dvh - 24px");
    expect(KANBAN_CSS).toContain("100dvh - 130px");
  });

  it("reflows the detail panel footer on narrow viewports", () => {
    // No 360px floor forcing the panel wider than small phones. Both panels
    // share the rule since the activity feed stopped duplicating
    // `#detail-panel-container` (ticket 45a8e57c), so the selector list grew.
    expect(KANBAN_CSS).toContain(
      "#detail-panel-container,#activity-panel-container{min-width:0}",
    );
    // …footer wraps (create-mode badges share the row), clears the home
    // indicator, and hits a 36px touch target.
    expect(KANBAN_CSS).toContain("flex-wrap:wrap");
    expect(KANBAN_CSS).toContain("safe-area-inset-bottom");
    expect(KANBAN_CSS).toContain(".dp-footer button{min-height:36px}");
  });
});
