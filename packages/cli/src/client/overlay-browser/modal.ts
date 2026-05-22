import type { ProtoConfig } from "./types.js";
declare const PROTO_CONFIG: ProtoConfig;
import type { Task } from "./types.js";
import type { SourcePointer } from "./selectors.js";
import { buildCssSelector } from "./selectors.js";
import { state } from "./state.js";
import { el } from "./dom.js";
import { fetchTasks, submitTask } from "./api.js";
import { showOverlayAddModal } from "../overlay-react/OverlayApp.js";
import { TASK_TYPE_CHOICES_DETAILED } from "./task-types.js";
import { buildTypePickerEl } from "./type-picker-el.js";

// ── Lightweight markdown renderer ─────────────────────────────────────────────

export function renderMarkdown(md: string): string {
  if (!md) return '<span class="modal-preview-empty">No description yet</span>';
  const escaped = md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/[*][*](.+?)[*][*]/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/[*](.+?)[*]/g, "<em>$1</em>")
    .replace(/_([^_]+?)_/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/^---$/gm, "<hr>")
    // eslint-disable-next-line security/detect-unsafe-regex -- input is our own generated HTML, not raw user input
    .replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/^(?!<[a-z]|$).+$/gm, line => `<p>${line}</p>`);
}

// ── Full-screen edit modal ────────────────────────────────────────────────────
// Showcase: overlay-showcase.html → [data-vibeflow-id="showcase-modal"]
export function showEditModal(task: Task): void {
  if (!state.root) return;
  if (state.editModal) { state.editModal.remove(); state.editModal = null; }

  const titleInput = el("input", { type: "text", placeholder: "Task title..." }) as HTMLInputElement;
  titleInput.value = task.title ?? "";

  const statusSelect = el("select") as HTMLSelectElement;
  for (const s of ["backlog", "todo", "in-progress", "review", "done"]) {
    const opt = el("option", { value: s }, s) as HTMLOptionElement;
    if (s === task.status) opt.selected = true;
    statusSelect.appendChild(opt);
  }

  const typePicker = buildTypePickerEl(task.type ?? "Task");

  const header = el("div", { className: "modal-header" }, titleInput, typePicker.el, statusSelect);

  const tabEdit = el("div", { className: "modal-tab active" }, "Edit");
  const tabPreview = el("div", { className: "modal-tab" }, "Preview");
  const tabs = el("div", { className: "modal-tabs" }, tabEdit, tabPreview);

  const textarea = el("textarea", { placeholder: "Description (markdown supported)..." }) as HTMLTextAreaElement;
  textarea.value = task.description ?? "";
  const editorPane = el("div", { className: "modal-editor-pane" }, textarea);
  const previewPane = el("div", { className: "modal-preview-pane" });
  previewPane.style.display = "none";

  const refreshPreview = () => { previewPane.innerHTML = renderMarkdown(textarea.value); };

  const body = el("div", { className: "modal-body" }, editorPane, previewPane);

  // Guard against Grammarly: correction fires a synthetic (untrusted) click on
  // the Preview tab. Real user clicks have event.isTrusted = true.
  tabEdit.addEventListener("click", () => {
    tabEdit.classList.add("active"); tabPreview.classList.remove("active");
    editorPane.style.display = ""; previewPane.style.display = "none";
  });
  tabPreview.addEventListener("click", (event) => {
    if (!event.isTrusted) return; // Grammarly fires untrusted synthetic clicks
    tabPreview.classList.add("active"); tabEdit.classList.remove("active");
    editorPane.style.display = "none"; previewPane.style.display = "";
    refreshPreview();
  });

  const btnSave = el("button", { className: "btn-primary" }, "Save");
  const btnCancel = el("button", { className: "btn-ghost" }, "Cancel");
  const footerLeft = el("div", { className: "modal-footer-left" }, btnSave, btnCancel);
  const footerRight = el("div", { className: "modal-footer-right" });
  const footerCenter = buildSourceRow({ file: task.file, line: task.line, col: task.col, component: task.component });
  const footer = el("div", { className: "modal-footer" }, footerLeft, footerCenter, footerRight);

  const modal = el("div", { className: "vibeflow-modal" }, header, tabs, body, footer);
  const backdrop = el("div", { className: "vibeflow-modal-backdrop" }, modal);
  state.editModal = backdrop;
  state.root.appendChild(backdrop);
  titleInput.focus();

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) { backdrop.remove(); state.editModal = null; }
  });

  btnSave.addEventListener("click", () => {
    const newTitle = titleInput.value.trim();
    if (!newTitle) return;
    const url = PROTO_CONFIG.boardId
      ? `${PROTO_CONFIG.apiUrl}/${task.id}?boardId=${encodeURIComponent(PROTO_CONFIG.boardId)}`
      : `${PROTO_CONFIG.apiUrl}/${task.id}`;
    fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle, status: statusSelect.value, type: typePicker.getValue(), description: textarea.value.trim() }),
    })
      .then(r => r.json())
      .then((d: { success?: boolean }) => { if (d.success) fetchTasksAndRender(); })
      .catch(err => console.error("[Vibeflow Studio]", err));
    backdrop.remove(); state.editModal = null;
  });

  btnCancel.addEventListener("click", () => { backdrop.remove(); state.editModal = null; });

  document.addEventListener("keydown", function onModalKey(e: KeyboardEvent) {
    if (!state.editModal) { document.removeEventListener("keydown", onModalKey); return; }
    if (e.key === "Escape") { backdrop.remove(); state.editModal = null; document.removeEventListener("keydown", onModalKey); }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { btnSave.click(); document.removeEventListener("keydown", onModalKey); }
  });
}

// Forward declarations resolved by index.ts registration
function fetchTasksAndRender(): void { fetchTasks(); }

// ── Source row helper (minimalistic file:line indicator) ─────────────────────

interface SourceOpts { file?: string; line?: number; col?: number; component?: string; }

function buildSourceRow(src: SourceOpts): HTMLElement {
  const row = el("div", { className: "modal-source-row" });
  if (!src.file && !src.component) return row;

  let label = "";
  if (src.file) {
    // Show only the last 2 path segments to keep it compact
    const parts = src.file.replace(/\\/g, "/").split("/");
    label = parts.slice(-2).join("/");
    if (src.line != null) label += `:${src.line}`;
    if (src.col != null) label += `:${src.col}`;
  } else if (src.component) {
    label = `⬡ ${src.component}`;
  }
  if (src.component && src.file) label += ` · ⬡ ${src.component}`;

  const sourceEl = el("span", { className: "modal-source-label", title: src.file ?? "" }, label);
  if (src.file && src.line != null) {
    const link = el("a", { className: "modal-source-link", title: "Open in editor", href: `vscode://file${src.file}:${src.line}`, target: "_blank" }, "↗");
    row.append(sourceEl, link);
  } else {
    row.append(sourceEl);
  }
  return row;
}

// ── Add Task Modal (no element selection required) ────────────────────────────
// Delegates to the React OverlayAddModal component (kanban-style UI).
// Falls back to vanilla DOM only if the React bridge is unavailable.

interface AddTaskModalOptions {
  initialTitle?: string;
  initialDescription?: string;
  selector?: string;
  cssSelector?: string;
  file?: string;
  line?: number;
  col?: number;
  component?: string;
  initialScreenshot?: string;
}

export function showAddTaskModal(opts: AddTaskModalOptions = {}): void {
  // Delegate to React overlay add modal for kanban-style UI
  showOverlayAddModal({
    initialTitle: opts.initialTitle,
    initialDescription: opts.initialDescription,
    selector: opts.selector,
    cssSelector: opts.cssSelector,
    file: opts.file,
    line: opts.line,
    col: opts.col,
    component: opts.component,
    initialScreenshot: opts.initialScreenshot,
  });
}

// ── Inspect Element Modal ─────────────────────────────────────────────────────
// Showcase: overlay-showcase.html → [data-vibeflow-id="showcase-popover"] → right-click → Inspect selector
//
// Shows all known identities for the element: selectors, source file, component,
// class list, attributes, and quick-copy actions.

export function showInspectModal(element: Element, pointer: SourcePointer): void {
  if (!state.root) return;
  if (state.editModal) { state.editModal.remove(); state.editModal = null; }

  const cssSelector = buildCssSelector(element);
  const tag = element.tagName.toLowerCase();
  const elId = element.getAttribute("id");
  const classes = Array.from(element.classList).filter(c => !c.startsWith("vibeflow-"));
  const dataAttrs = Array.from(element.attributes)
    .filter(a => a.name.startsWith("data-") && !a.name.startsWith("data-proto"))
    .map(a => ({ name: a.name, value: a.value }));

  // ── Header ──────────────────────────────────────────────────────────────
  const heading = el("div", { className: "inspect-heading" },
    el("span", { className: "inspect-tag" }, `<${tag}>`),
    el("span", { className: "inspect-title" }, "Element Inspector"),
  );
  const closeBtn = el("button", { className: "inspect-close" }, "✕");

  // ── Rows ────────────────────────────────────────────────────────────────
  function makeRow(label: string, value: string, copyable = true): HTMLElement {
    const row = el("div", { className: "inspect-row" });
    const lbl = el("span", { className: "inspect-row-label" }, label);
    const val = el("code", { className: "inspect-row-value" }, value || "—");
    row.append(lbl, val);
    if (copyable && value) {
      const btn = el("button", { className: "inspect-copy-btn", title: "Copy" }, "⎘");
      btn.addEventListener("click", () => {
        navigator.clipboard?.writeText(value).catch(() => { /* ignore */ });
        btn.textContent = "✓";
        setTimeout(() => { btn.textContent = "⎘"; }, 1200);
      });
      row.appendChild(btn);
    }
    return row;
  }

  const rows = el("div", { className: "inspect-rows" });

  // Selector fields
  rows.appendChild(makeRow("Selector", pointer.selector));
  if (cssSelector !== pointer.selector) rows.appendChild(makeRow("CSS selector", cssSelector));
  if (pointer.test_id) rows.appendChild(makeRow("Test ID", pointer.test_id));
  if (elId) rows.appendChild(makeRow("id", elId));
  if (classes.length > 0) rows.appendChild(makeRow("Classes", classes.join(" ")));

  // Source fields (Tier 1)
  if (pointer.file) {
    const fileLine = pointer.file + (pointer.line != null ? `:${pointer.line}` : "") + (pointer.col != null ? `:${pointer.col}` : "");
    const srcRow = makeRow("Source file", fileLine);
    if (pointer.line != null) {
      const openLink = el("a", { className: "inspect-copy-btn", title: "Open in VS Code", href: `vscode://file${pointer.file}:${pointer.line}`, target: "_blank" }, "↗");
      srcRow.appendChild(openLink);
    }
    rows.appendChild(srcRow);
  }
  if (pointer.component) rows.appendChild(makeRow("Component", pointer.component));

  // data-* attributes
  for (const attr of dataAttrs) rows.appendChild(makeRow(attr.name, attr.value));

  // ── Copy all button ──────────────────────────────────────────────────────
  const copyAllBtn = el("button", { className: "inspect-copy-all-btn" }, "⎘ Copy all");
  copyAllBtn.addEventListener("click", () => {
    const lines: string[] = [];
    if (pointer.file) lines.push(`Source: ${pointer.file}${pointer.line != null ? `:${pointer.line}` : ""}${pointer.col != null ? `:${pointer.col}` : ""}`);
    if (pointer.component) lines.push(`Component: ${pointer.component}`);
    if (pointer.test_id) lines.push(`TestID: ${pointer.test_id}`);
    lines.push(`Selector: ${pointer.selector}`);
    if (cssSelector !== pointer.selector) lines.push(`CSS selector: ${cssSelector}`);
    if (elId) lines.push(`id: ${elId}`);
    if (classes.length > 0) lines.push(`Classes: ${classes.join(" ")}`);
    navigator.clipboard?.writeText(lines.join("\n")).catch(() => { /* ignore */ });
    copyAllBtn.textContent = "✓ Copied!";
    setTimeout(() => { copyAllBtn.textContent = "⎘ Copy all"; }, 1500);
  });

  const box = el("div", { className: "vibeflow-inspect-modal" },
    el("div", { className: "inspect-header" }, heading, closeBtn),
    rows,
    el("div", { className: "inspect-footer" }, copyAllBtn),
  );
  const backdrop = el("div", { className: "vibeflow-modal-backdrop" }, box);
  state.editModal = backdrop;
  state.root.appendChild(backdrop);

  closeBtn.addEventListener("click", () => { backdrop.remove(); state.editModal = null; });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) { backdrop.remove(); state.editModal = null; }
  });
  document.addEventListener("keydown", function onInspectKey(e: KeyboardEvent) {
    if (!state.editModal) { document.removeEventListener("keydown", onInspectKey); return; }
    if (e.key === "Escape") { backdrop.remove(); state.editModal = null; document.removeEventListener("keydown", onInspectKey); }
  });
}
