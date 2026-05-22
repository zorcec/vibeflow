import { el } from "./dom.js";
import { TASK_TYPE_CHOICES_DETAILED } from "./task-types.js";

type TypeEntry = { value: string; icon: string; label: string; tooltip: string };

// Creates an overlay TypePicker element that exactly matches the kanban TypePicker.tsx style.
// Shows icon + label as the trigger button; clicking opens a vertical dropdown with all options.
export function buildTypePickerEl(initialType = "Task"): {
  el: HTMLElement;
  getValue: () => string;
  setValue: (v: string) => void;
} {
  let selectedType = initialType;
  const detailed = TASK_TYPE_CHOICES_DETAILED as readonly TypeEntry[];
  const currentInfo = () => detailed.find(t => t.value === selectedType) ?? detailed[0]!;

  const container = el("div", { className: "type-picker" });
  const trigger = el("button", { className: "type-picker-trigger", type: "button" }) as HTMLButtonElement;
  const dropdown = el("div", { className: "type-picker-dropdown" });

  const refresh = () => {
    const info = currentInfo();
    trigger.title = info?.tooltip ?? "";
    trigger.replaceChildren(
      el("span", { className: "type-picker-icon" }, info?.icon ?? ""),
      el("span", { className: "type-picker-label" }, info?.label ?? ""),
    );
    dropdown.replaceChildren();
    for (const t of detailed) {
      const opt = el("button", {
        className: t.value === selectedType ? "type-picker-option type-picker-option--active" : "type-picker-option",
        type: "button",
        title: t.tooltip,
      },
        el("span", { className: "type-picker-icon" }, t.icon),
        el("span", { className: "type-picker-label" }, t.label),
      );
      opt.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectedType = t.value;
        refresh();
        dropdown.classList.remove("open");
      });
      dropdown.appendChild(opt);
    }
  };

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropdown.classList.toggle("open");
  });

  refresh();
  container.append(trigger, dropdown);

  return {
    el: container,
    getValue: () => selectedType,
    setValue: (v: string) => { selectedType = v; refresh(); },
  };
}
