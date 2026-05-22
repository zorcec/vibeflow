import { state } from "./state.js";
import { el } from "./dom.js";
import { buildSourcePointerAsync, buildCssSelector } from "./selectors.js";
import { submitTask } from "./api.js";
import { setAnnotateHighlight, clearAnnotateHighlight } from "./ui.js";
import { buildTypePickerEl } from "./type-picker-el.js";
import { flashOverlayTrigger } from "../overlay-react/OverlayApp.js";
import { getRecordedLogs } from "./error-recorder.js";
import { detectReactQuality } from "./react-detect.js";
import { showReactQualityModal, hasShownQualityModal, markQualityModalShown } from "./react-quality-modal.js";

// ── Annotation popover (create new task from right-click or click-to-annotate)
// Showcase: overlay-showcase.html → [data-vibeflow-id="showcase-popover"]

export async function showPopover(element: Element, x?: number, y?: number): Promise<void> {
  if (!state.root) return;
  if (state.popover) { state.popover.remove(); state.popover = null; }

  const pointer = await buildSourcePointerAsync(element);
  const selector = pointer.selector;
  const cssSelector = buildCssSelector(element);
  const displayName = pointer.display;

  // ── Header: target element identity ─────────────────────────────────────
  const targetIcon = el("div", { className: "popover-target-icon" }, "⬡");
  const targetName = el("div", { className: "popover-target-name" }, displayName.slice(0, 50));

  // ── React quality badge replaces the drag-handle grip icon ──────────────
  // Quality levels drive color range: none=red, partial=amber, full/not-react=neutral.
  const reactQuality = detectReactQuality();
  const showBadge = reactQuality !== 'not-react' && reactQuality !== 'full';
  const qualityTooltip: Record<string, string> = {
    none:           'React production build — no component context available (click to learn more)',
    partial:        'React partial context — component name only, no source file (click to learn more)',
    full:           'Drag to move',
    'not-react':    'Drag to move',
  };
  const dragHandleClass = showBadge
    ? `popover-drag-handle popover-drag-handle--quality-${reactQuality}`
    : 'popover-drag-handle';

  const dragHandle = el("div", {
    className: dragHandleClass,
    title: qualityTooltip[reactQuality] ?? 'Drag to move',
  });

  // When sourcemaps are fully available, show a grip icon for dragging.
  // When quality is degraded, keep the warning "⚠" which opens the educational modal.
  if (showBadge) {
    dragHandle.appendChild(document.createTextNode("⚠"));
  } else {
    const gripSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    gripSvg.setAttribute("width", "12");
    gripSvg.setAttribute("height", "16");
    gripSvg.setAttribute("viewBox", "0 0 12 16");
    gripSvg.setAttribute("fill", "currentColor");
    gripSvg.setAttribute("aria-hidden", "true");
    const gripDots: [number, number][] = [[3,3],[9,3],[3,8],[9,8],[3,13],[9,13]];
    for (const [cx, cy] of gripDots) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(cy));
      circle.setAttribute("r", "1.5");
      gripSvg.appendChild(circle);
    }
    dragHandle.appendChild(gripSvg);
  }
  const header = el("div", { className: "popover-header" }, targetIcon, targetName, dragHandle);

  // ── Source pointer (minimalistic, shown only when available) ─────────────
  const sourceRow = el("div", { className: "popover-source" });
  if (pointer.file) {
    const parts = pointer.file.replace(/\\/g, "/").split("/");
    const label = parts.slice(-2).join("/") + (pointer.line != null ? `:${pointer.line}` : "");
    const srcLink = el("a", { href: `vscode://file${pointer.file}${pointer.line != null ? `:${pointer.line}` : ""}`, target: "_blank", title: pointer.file }, label);
    if (pointer.component) {
      sourceRow.append(srcLink, el("span", { className: "popover-source-sep" }, " · ⬡ " + pointer.component));
    } else {
      sourceRow.appendChild(srcLink);
    }
  } else if (pointer.component) {
    sourceRow.appendChild(el("span", null, "⬡ " + pointer.component));
  }

  // ── Body: inputs ─────────────────────────────────────────────────────────
  const titleInput = el("input", { type: "text", placeholder: "Task title..." }) as HTMLInputElement;
  const textarea = el("textarea", { placeholder: "Describe your feedback..." }) as HTMLTextAreaElement;

  const typePicker = buildTypePickerEl("Task");

  const titleRow = el("div", { className: "popover-title-row" }, typePicker.el, titleInput);
  const body = el("div", { className: "popover-body" }, titleRow, textarea);

  // ── Footer: actions ───────────────────────────────────────────────────────
  const btnSave = el("button", { className: "btn-primary" }, "Save");
  const btnCancel = el("button", null, "Cancel");
  const spacer = el("div", { className: "popover-actions-spacer" });

  const actions = el("div", { className: "popover-actions" }, btnSave, btnCancel, spacer);

  const popover = el("div", { className: "vibeflow-popover" }, header, sourceRow, body, actions);
  state.popover = popover;

  // Auto-show modal once if quality is not full
  if (showBadge && !hasShownQualityModal()) {
    markQualityModalShown();
    window.setTimeout(() => showReactQualityModal(reactQuality), 200);
  }

  // Quality-aware drag handle: click opens educational modal; drag moves popover
  if (showBadge) {
    dragHandle.addEventListener("click", (e) => {
      e.stopPropagation();
      showReactQualityModal(reactQuality);
    });
  }

  popover.addEventListener("click", (e: MouseEvent) => {
    if (!(e.target as Element).closest(".type-picker")) {
      popover.querySelector(".type-picker-dropdown")?.classList.remove("open");
    }
  });

  const posX = x !== undefined ? x : element.getBoundingClientRect().left;
  const posY = y !== undefined ? y : element.getBoundingClientRect().bottom + 8;
  popover.style.left = `${Math.min(posX, window.innerWidth - 620)}px`;
  popover.style.top = `${Math.min(posY, window.innerHeight - 350)}px`;

  // ── Drag-to-move via grip handle ──────────────────────────────────────────
  let dragState: { startX: number; startY: number; origLeft: number; origTop: number } | null = null;
  dragHandle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    dragHandle.setPointerCapture(e.pointerId);
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: parseInt(popover.style.left, 10) || 0,
      origTop: parseInt(popover.style.top, 10) || 0,
    };
    popover.classList.add("popover-dragging");
  });
  dragHandle.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const maxX = window.innerWidth - (popover.offsetWidth || 480);
    const maxY = window.innerHeight - (popover.offsetHeight || 250);
    popover.style.left = `${Math.max(0, Math.min(maxX, dragState.origLeft + dx))}px`;
    popover.style.top = `${Math.max(0, Math.min(maxY, dragState.origTop + dy))}px`;
  });
  dragHandle.addEventListener("pointerup", () => {
    dragState = null;
    popover.classList.remove("popover-dragging");
  });
  dragHandle.addEventListener("pointercancel", () => {
    dragState = null;
    popover.classList.remove("popover-dragging");
  });

  state.root.appendChild(popover);
  titleInput.focus();

  btnSave.addEventListener("click", () => {
    const text = textarea.value.trim();
    const rawTitle = titleInput.value.trim();
    if (!rawTitle) {
      // Re-trigger animation on repeated attempts by forcing a reflow
      titleInput.classList.remove("input-error");
      void (titleInput as HTMLElement).offsetWidth;
      titleInput.classList.add("input-error");
      titleInput.focus();
      const clear = () => { titleInput.classList.remove("input-error"); titleInput.removeEventListener("input", clear); };
      titleInput.addEventListener("input", clear);
      return;
    }
    const title = rawTitle;
    if (!text && !title) return;
    const rawInnerText = (element as HTMLElement).innerText?.trim() ?? '';
    const capturedHtmlText = rawInnerText ? rawInnerText.slice(0, 300) : undefined;
    const selectedType = typePicker.getValue();
    let desc = text || title;
    if (selectedType === 'Bug') {
      const logs = getRecordedLogs();
      if (logs) desc += logs;
    }
    submitTask(selector, cssSelector, title, desc, undefined, {
      file: pointer.file,
      line: pointer.line,
      col: pointer.col,
      component: pointer.component,
    }, selectedType || undefined, capturedHtmlText);
    state.popover?.remove(); state.popover = null;
    clearAnnotateHighlight();
    flashOverlayTrigger();
  });

  btnCancel.addEventListener("click", () => {
    state.popover?.remove(); state.popover = null;
    clearAnnotateHighlight();
  });
}
