import { describe, it, expect } from "vitest";
import { getOverlayScript } from "../../src/client/overlay/index.js";

describe("getOverlayScript", () => {
  it("detects server origin from document.currentScript for bookmarklet support", () => {
    const script = getOverlayScript(3700);
    // Uses document.currentScript.src when available (bookmarklet/script-tag injection)
    // so overlay points to CLI server even when injected on a different-origin page (e.g. wsl.localhost)
    expect(script).toContain("document.currentScript");
    expect(script).toContain("_vfScriptSrc");
    expect(script).toContain("_vfOrigin");
    expect(script).toContain("window.location.host"); // fallback for inline injection
  });

  it("returns a non-empty string", () => {
    const script = getOverlayScript(3700);
    expect(script.length).toBeGreaterThan(100);
  });

  it("includes the correct WebSocket URL with port", () => {
    const script = getOverlayScript(4000);
    // Script detects server origin from document.currentScript.src (bookmarklet) or window.location.host (inline)
    expect(script).toContain("_vfOrigin.replace(/^http/, 'ws')");
    expect(script).toContain(`port: 4000`);
  });

  it("includes task API URL with port", () => {
    const script = getOverlayScript(3700);
    // Script uses dynamically resolved origin so bookmarklets always point to the CLI server
    expect(script).toContain("_vfOrigin + '/api/tasks'");
    expect(script).toContain(`port: 3700`);
  });

  it("contains status badges but no tag badges", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("status-badge");
    expect(script).not.toContain("tag-badge");
    expect(script).not.toContain("TAG_COLORS");
  });

  it("includes keyboard shortcut handlers", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain('e.altKey&&e.key==="a"');
    expect(script).toContain('e.altKey&&e.key==="s"');
    expect(script).toContain("Escape");
  });

  it("is wrapped in an IIFE", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("(()=>{");
    expect(script).toContain("})();");
  });

  it("uses different port numbers correctly", () => {
    const script8080 = getOverlayScript(8080);
    // Port is embedded in PROTO_CONFIG; origin is resolved at runtime from script src or location
    expect(script8080).toContain(`port: 8080`);
    expect(script8080).toContain("_vfOrigin");
    expect(script8080).toContain("document.currentScript");
    // Should not contain other port numbers in the PROTO_CONFIG
    expect(script8080).not.toContain(`port: 3700`);
  });

  it("includes dark theme CSS (#0f172a)", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("#0f172a");
    expect(script).toContain("#1e293b");
  });

  it("includes corner trigger button for sidebar", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("vibeflow-corner-trigger");
  });

  it("includes sidebar with task cards", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("vibeflow-sidebar");
    expect(script).toContain("task-card");
  });

  it("popover header title does not inherit popover-label spacing", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain('className:"popover-target-name"');
    expect(script).not.toContain('popover-target-name popover-label');
  });

  it("in-progress task cards get blue class and spinner", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("task-card in-progress");
    expect(script).toContain("task-spinner");
    expect(script).toContain("vibeflow-spin");
  });

  it("includes context menu", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("vibeflow-context-menu");
    expect(script).toContain("contextmenu");
  });

  it("includes ping/pong keepalive for stable WS", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("ping");
    expect(script).toContain("pong");
    expect(script).toContain("PING_INTERVAL");
  });

  it("includes exponential backoff reconnection", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("RECONNECT_BASE");
    expect(script).toContain("RECONNECT_MAX");
    expect(script).toContain("scheduleReconnect");
  });

  it("includes conflict guard for Chrome extension", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("vibeflow-studio-root");
  });

  it("includes task indicator rendering", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("renderIndicators");
    expect(script).toContain("vibeflow-task-indicator");
    expect(script).toContain("vibeflow-indicators");
  });

  it("re-renders indicators on scroll and resize", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("scheduleRenderIndicators");
    expect(script).toContain("scroll");
    expect(script).toContain("resize");
  });

  it("includes tooltip for indicator hover", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("showIndicatorTooltip");
    expect(script).toContain("hideIndicatorTooltip");
    expect(script).toContain("vibeflow-task-tooltip");
  });

  it("includes full-screen edit modal", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("showEditModal");
    expect(script).toContain("modal-tab");
    expect(script).toContain("renderMarkdown");
  });

  it("edit modal sends PATCH request with status, title, description", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("PATCH");
    expect(script).toContain("statusSelect.value");
    expect(script).not.toContain("tagSelect.value");
  });

  it("sidebar task cards have edit buttons", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("edit-btn");
    expect(script).toContain("showEditModal");
  });

  it("calls renderIndicators after fetchTasks", () => {
    const script = getOverlayScript(3700);
    // renderIndicators should be called inside the fetchTasks then-callback
    const fetchIdx = script.indexOf("function fetchTasks");
    const indicatorIdx = script.indexOf("renderIndicators()", fetchIdx);
    expect(indicatorIdx).toBeGreaterThan(fetchIdx);
  });

  it("includes show/hide indicators toggle with localStorage persistence", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("indicatorsVisible");
    expect(script).toContain("PREFS_KEY");
    expect(script).toContain("localStorage");
  });

  it("includes show/hide done tasks toggle", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("sidebarShowDone");
    expect(script).toContain("sidebar-legend");
    expect(script).toContain("legend-toggle");
  });

  it("show done filter triggers renderIndicators (filter applies to both overlay and sidebar)", () => {
    const script = getOverlayScript(3700);
    // show-done preference affects indicator visibility for all-done groups
    expect(script).toContain("sidebarShowDone");
    expect(script).toContain("allDone&&!state.sidebarShowDone");
  });

  it("renderIndicators hides all-done group when sidebarShowDone is false", () => {
    const script = getOverlayScript(3700);
    // Guard: skip all-done indicator when sidebarShowDone is false
    expect(script).toContain("allDone&&!state.sidebarShowDone");
  });

  it("includes sticky tooltip on click (tooltipPinned)", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("tooltipPinned");
    expect(script).toContain("forceHideTooltip");
    expect(script).toContain("tooltip-close-btn");
  });

  it("edit modal footer has styled button classes", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("btn-primary");
    expect(script).toContain("btn-ghost");
    expect(script).toContain("modal-footer-left");
    expect(script).toContain("modal-footer-right");
  });

  it("sidebar filters tasks by current page URL and shows other-pages hint", () => {
    const script = getOverlayScript(3700);
    // Indicators are scoped to the current page URL
    expect(script).toContain("location.pathname");
    expect(script).toContain("pageTasks");
    expect(script).toContain("t.url===currentPath");
  });

  it("includes click-outside handler to close pinned tooltip", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("composedPath");
    expect(script).toContain("forceHideTooltip");
  });

  it("uses buildSourcePointer for flexible selector generation", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("buildSourcePointer");
    // Falls back through: data-vibeflow-id → data-testid → id → CSS path
    expect(script).toContain("data-testid");
    expect(script).toContain("data-vibeflow-id");
  });

  it("submitTask uses full selector string, not bare protoId", () => {
    const script = getOverlayScript(3700);
    // submitTask first param is selector (a '[attr="id"]' string), not protoId
    expect(script).toContain("submitTask(selector,");
    // selector must not be hardcoded inside submitTask body
    const submitIdx = script.indexOf("function submitTask(selector,");
    const hardcoded = script.indexOf('[data-vibeflow-id="\'', submitIdx);
    expect(hardcoded).toBe(-1);
  });

  it("includes page switcher for variant navigation", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("vibeflow-page-switcher");
    expect(script).toContain("fetchPages");
    expect(script).toContain("PAGES_URL");
    expect(script).toContain("renderPageSwitcher");
  });

  it("filters indicators by current page URL", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("location.pathname");
    expect(script).toContain("pageTasks");
  });

  it("buildSourcePointer anchors CSS path to ancestor data-testid", () => {
    const script = getOverlayScript(3700);
    // Selector resolution checks ancestor data-testid attributes
    expect(script).toContain("data-testid");
    // Tiered resolution is present
    expect(script).toContain("buildSourcePointer");
  });

  it("context menu has single Annotate option (no type options)", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("annotateBtn");
    expect(script).not.toContain("Add TODO");
    expect(script).not.toContain("Add FEATURE");
  });

  it("context menu shows Prototyping option when __vf_prototyping API is present", () => {
    const script = getOverlayScript(3700);
    // The app-level right-click context menu must conditionally show a Prototyping item
    // when @vibeflow-tools/ui-prototyping is installed and has registered its API.
    expect(script).toContain("__vf_prototyping");
    expect(script).toContain("Prototyping");
    expect(script).toContain("openPanel");
  });

  it("the compiled overlay script is valid JavaScript (no SyntaxError)", () => {
    // Regression: template-literal escape issues caused /^// and invalid regexes
    // that broke the overlay in the browser with 'Unexpected token ,' or similar.
    const script = getOverlayScript(3700);
    expect(() => new Function(script)).not.toThrow();
  });

  it("renderMarkdown is included and can render basic markdown constructs", () => {
    const script = getOverlayScript(3700);
    // The function must exist
    expect(script).toContain("function renderMarkdown");
    // Must support headings, bold, italic, lists, inline code
    expect(script).toContain("<h1>");
    expect(script).toContain("<strong>");
    expect(script).toContain("<em>");
    expect(script).toContain("<code>");
    expect(script).toContain("<ul>");
  });

  it("edit modal has Edit and Preview tabs", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("modal-tab");
    expect(script).toContain("modal-preview-pane");
    expect(script).toContain("modal-editor-pane");
    expect(script).toContain("Edit");
    expect(script).toContain("Preview");
  });

  it("edit modal supports Escape key to close and Ctrl+Enter to save", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("Escape");
    expect(script).toContain("ctrlKey");
  });

  it("renderIndicators skips elements outside the viewport", () => {
    const script = getOverlayScript(3700);
    // Viewport visibility check must be present in renderIndicators
    expect(script).toContain("vpW");
    expect(script).toContain("vpH");
    expect(script).toContain("rect.bottom<0");
    expect(script).toContain("rect.top>vpH");
    expect(script).toContain("rect.right<0");
    expect(script).toContain("rect.left>vpW");
  });

  it("single-task indicator click opens edit modal directly without tooltip", () => {
    const script = getOverlayScript(3700);
    // The click handler must branch on grp.length === 1
    expect(script).toContain("grp.length===1");
    // Single task: open edit modal directly
    expect(script).toContain("showEditModal(grp[0])");
  });

  it("multi-task indicator click still pins tooltip for selection", () => {
    const script = getOverlayScript(3700);
    // Multi-task branch must still pin tooltip
    const clickIdx = script.indexOf("grp.length===1");
    expect(clickIdx).toBeGreaterThan(-1);
    // After the single-task branch there must be a tooltipPinned = true
    const afterClick = script.slice(clickIdx, clickIdx + 500);
    expect(afterClick).toContain("tooltipPinned=!0");
  });

  // ── Regression: tasks.md fixes ────────────────────────────────────────────

  it("buildCssSelector function is defined for CSS selector storage", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("function buildCssSelector");
    // Used in showPopover to compute cssSelector
    expect(script).toContain("cssSelector=buildCssSelector(element)");
  });

  it("submitTask includes cssSelector in POST body", () => {
    const script = getOverlayScript(3700);
    // submitTask must pass cssSelector to POST body
    expect(script).toContain("cssSelector:cssSelector");
    // Function must accept cssSelector as second param
    expect(script).toContain("function submitTask(selector,cssSelector,");
  });

  it("click-to-annotate uses e.target directly (not .closest ancestors)", () => {
    const script = getOverlayScript(3700);
    // Anchor on the click-to-annotate setup function
    const clickAnnotateIdx = script.indexOf("function setupClickToAnnotate");
    expect(clickAnnotateIdx).toBeGreaterThan(-1);
    const clickSection = script.slice(clickAnnotateIdx, clickAnnotateIdx + 400);
    // Must use e.target directly
    expect(clickSection).toContain("target=e.target;");
    // Must NOT traverse ancestry for data-testid in the click handler
    expect(clickSection).not.toContain("e.target.closest('[data-testid]')");
  });

  it("contextmenu handler uses e.target directly (not .closest ancestors)", () => {
    const script = getOverlayScript(3700);
    const ctxIdx = script.indexOf("function setupContextMenuListener");
    expect(ctxIdx).toBeGreaterThan(-1);
    const ctxSection = script.slice(ctxIdx, ctxIdx + 400);
    expect(ctxSection).toContain("target=e.target;");
    expect(ctxSection).not.toContain("e.target.closest('[data-testid]')");
  });

  it("sidebar shows ALL tasks — showAllPages toggle controls visibility", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("showAllPages");
    // Preference is loaded from localStorage into shared state
    expect(script).toContain("state.showAllPages");
  });

  it("sidebar shows URL badge for tasks from other pages", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("task-url-badge");
    expect(script).toMatch(/url\s*!==/);
  });

  it("SPA navigation detection monkey-patches pushState and replaceState", () => {
    const script = getOverlayScript(3700);
    expect(script).toContain("history.pushState");
    expect(script).toContain("history.replaceState");
    // Must also listen for popstate
    expect(script).toContain("popstate");
  });

  it("re-renders overlay on hashchange (hash-based routing support)", () => {
    const script = getOverlayScript(3700);
    // hashchange fires when location.hash changes via anchor clicks or location.hash assignment
    // (not covered by popstate/pushState patches)
    expect(script).toContain("hashchange");
    // Ensure routing hooks are all wired in the same script payload
    expect(script).toContain("history.pushState");
    expect(script).toContain("history.replaceState");
    expect(script).toContain("popstate");
  });

  it("refreshes indicators after user click interactions (debounced)", () => {
    const script = getOverlayScript(3700);
    // Must listen on both click and keyup (handler name can be minified)
    expect(script).toContain('addEventListener("click"');
    expect(script).toContain('addEventListener("keyup"');
    // Must use a 150ms debounce and refresh indicators (renderIndicators may be minified)
    expect(script).toContain("setTimeout(");
    expect(script).toMatch(/,\s*150\)/);
    // Must exclude clicks on the overlay host
    expect(script).toContain("composedPath().indexOf(");
  });

  it("console.log messages exist in overlay for debugging", () => {
    const script = getOverlayScript(3700);
    // Existing error logs should still be present
    expect(script).toContain("[Vibeflow Studio]");
  });
});
