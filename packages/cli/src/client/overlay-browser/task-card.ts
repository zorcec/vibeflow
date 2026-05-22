import type { Task } from "./types.js";
import { el } from "./dom.js";
import { getTaskTypeIcon, TASK_TYPE_CHOICES_DETAILED } from "./task-types.js";

function getTaskTypeTooltip(type?: string | null): string {
  return TASK_TYPE_CHOICES_DETAILED.find(t => t.value === (type ?? 'Task'))?.tooltip ?? '';
}

interface BuildTaskCardOptions {
  currentPath: string;
  onOpen: (task: Task) => void;
  onDone?: (task: Task) => void;
  onDelete?: (task: Task) => void;
  showSelector?: boolean;
  showDescription?: boolean;
  showActions?: boolean;
}

export function buildOverlayTaskCard(task: Task, options: BuildTaskCardOptions): HTMLElement {
  const {
    currentPath,
    onOpen,
    onDone,
    onDelete,
    showSelector = true,
    showDescription = true,
    showActions = false,
  } = options;

  const statusBadge = el("span", { className: `status-badge status-${task.status.replace(" ", "-")}` }, task.status);
  const effectiveType = task.type ?? "Task";
  const typeBadge = el("span", {
    className: `type-badge type-badge-${effectiveType.toLowerCase()}`,
    title: getTaskTypeTooltip(effectiveType),
  }, effectiveType);
  const header = el("div", { className: "task-card-header" }, statusBadge, typeBadge);

  if (task.status === "in-progress") {
    header.appendChild(el("span", { className: "task-spinner" }));
  }

  if (task.url && task.url !== currentPath) {
    header.appendChild(el("span", { className: "task-url-badge" }, task.url));
  }

  const icon = getTaskTypeIcon(task.type);
  const card = el("div", { className: task.status === "in-progress" ? "task-card in-progress" : "task-card" },
    el("span", { className: "task-watermark", title: `Type: ${task.type ?? "Task"}` }, icon),
    header,
    el("div", { className: "task-title" }, task.title ?? "Untitled"),
  );

  if (showSelector) {
    card.appendChild(el("div", { className: "task-selector" }, task.selector));
  }

  if (showDescription && task.description) {
    card.appendChild(el("div", { className: "task-description" }, task.description));
  }

  card.addEventListener("click", (e: MouseEvent) => {
    if ((e.target as Element).closest?.(".task-actions")) return;
    onOpen(task);
  });

  if (showActions) {
    const actions = el("div", { className: "task-actions" });
    if (task.status !== "done" && onDone) {
      const doneBtn = el("button", { className: "done-btn" }, "✓ Done");
      doneBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        onDone(task);
      });
      actions.appendChild(doneBtn);
    }
    if (onDelete) {
      const deleteBtn = el("button", { className: "delete-btn" }, "✕");
      deleteBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        onDelete(task);
      });
      actions.appendChild(deleteBtn);
    }
    card.appendChild(actions);
  }

  return card;
}
