import React from "react";
import { Plus } from "lucide-react";
import type { Task, Column, TaskStatus, LiveActivity } from "../types";
import { TaskCard } from "./TaskCard";
import {
  groupTasksByRoot,
  classifyForDropIntent,
  targetValid,
  canReparent,
  getParent,
  dragSession,
} from "../task-links";
import type { DropIntent } from "../task-links";
import { compareTaskOrder } from "../utils";

const COLUMNS: Column[] = [
  {
    id: "backlog",
    label: "Backlog",
    color: "var(--p-text-f)",
    accent: "color-mix(in srgb, var(--p-text-g) 25%, transparent)",
  },
  {
    id: "todo",
    label: "Todo",
    color: "var(--p-amber)",
    accent: "color-mix(in srgb, var(--p-amber) 18%, transparent)",
  },
  {
    id: "in-progress",
    label: "In Progress",
    color: "var(--p-blue)",
    accent: "color-mix(in srgb, var(--p-blue) 18%, transparent)",
    glow: true,
  },
  {
    id: "review",
    label: "Review",
    color: "var(--p-purple)",
    accent: "color-mix(in srgb, var(--p-purple) 18%, transparent)",
  },
  {
    id: "done",
    label: "Done",
    color: "var(--p-green)",
    accent: "color-mix(in srgb, var(--p-green) 18%, transparent)",
  },
];

export { COLUMNS };

const SKELETON_COUNT = 3;

function SkeletonCard() {
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid var(--p-border-t)",
        padding: "10px 12px",
        background: "var(--p-bg-2)",
        marginBottom: 6,
        animation: "skeleton-pulse 1.5s ease-in-out infinite",
      }}
    >
      <div
        style={{
          height: 12,
          borderRadius: 4,
          background: "var(--p-border-s)",
          width: "75%",
          marginBottom: 8,
        }}
      />
      <div
        style={{
          height: 10,
          borderRadius: 4,
          background: "var(--p-border-s)",
          width: "50%",
          marginBottom: 8,
        }}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <div
          style={{
            height: 18,
            borderRadius: 10,
            background: "var(--p-border-s)",
            width: 48,
          }}
        />
        <div
          style={{
            height: 18,
            borderRadius: 10,
            background: "var(--p-border-s)",
            width: 36,
          }}
        />
      </div>
    </div>
  );
}

// DropIntent is imported from task-links (single-ref architecture)

interface Props {
  tasks: Task[];
  visibleCols: TaskStatus[];
  searchQuery: string;
  isLoading?: boolean;
  liveActivities?: Map<string, LiveActivity>;
  onOpenPanel: (
    task: Task | null,
    tab?: "details" | "comments" | "files",
    columnId?: TaskStatus,
  ) => void;
  onDrop: (taskId: string, newStatus: TaskStatus) => void;
  /** Compact view: one-line done-style rows across all lanes. */
  compact?: boolean;
  /** Called when a task is dropped at a specific position within/across columns. */
  onReorder?: (
    taskId: string,
    newStatus: TaskStatus,
    beforeId: string | null,
    afterId: string | null,
    explicitSortKey?: string,
  ) => void;
  /** Link a task as a child of another task (optimistic PATCH). */
  onLinkChild?: (draggedId: string, parentId: string) => void;
  /** Sibling reorder inside one parent (tree-row intent, same parent). */
  onTreeReorder?: (
    draggedId: string,
    targetId: string,
    position: "before" | "after",
    parentId: string,
  ) => void;
  /** Move under a different parent (tree-row intent across parents). */
  onTreeReparent?: (
    draggedId: string,
    newParentId: string,
    targetId?: string,
    position?: "before" | "after",
  ) => void;
}

export function KanbanBoard({
  tasks,
  visibleCols,
  searchQuery,
  isLoading,
  liveActivities,
  compact,
  onOpenPanel,
  onDrop,
  onReorder,
  onLinkChild,
  onTreeReorder,
  onTreeReparent,
}: Props) {
  const boardRef = React.useRef<HTMLElement>(null);
  const thumbRef = React.useRef<HTMLDivElement>(null);
  /** Single drop-intent ref — replaces the 4-state+4-ref lockstep.
   * Every dragover handler OVERWRITES its own intent (card/zone/column).
   * No handler nulls another handler's intent; the next hover overwrites.
   * Consumed (read + cleared) only by handleDrop and handleDragEnd. */
  const dropIntentRef = React.useRef<DropIntent | null>(null);
  const [dropIntent, setDropIntent] = React.useState<DropIntent | null>(null);
  const [dragTaskId, setDragTaskId] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState<string | null>(null);
  /** Track the last make-child pill target for rendering — derived from
   * dropIntent but kept as state for React render cycle. */
  const [makeChildTarget, setMakeChildTarget] = React.useState<{
    taskId: string;
    title: string;
    isZone: boolean;
  } | null>(null);
  const dragTaskIdRef = React.useRef<string | null>(null);

  const filtered = searchQuery
    ? tasks.filter(
        (t) =>
          (t.title ?? "").toLowerCase().includes(searchQuery.toLowerCase()) ||
          (t.description ?? "")
            .toLowerCase()
            .includes(searchQuery.toLowerCase()),
      )
    : tasks;

  const cols = COLUMNS.filter((c) => visibleCols.includes(c.id));

  // Custom scrollbar sync
  React.useEffect(() => {
    const board = boardRef.current;
    const thumb = thumbRef.current;
    if (!board || !thumb) return;

    function update() {
      if (!board || !thumb) return;
      const ratio =
        board.scrollWidth > board.clientWidth
          ? board.clientWidth / board.scrollWidth
          : 1;
      const thumbWidth = Math.max(40, board.clientWidth * ratio);
      thumb.style.width = `${thumbWidth}px`;
      const maxScroll = board.scrollWidth - board.clientWidth;
      const thumbRange = board.clientWidth - thumbWidth;
      thumb.style.left = `${maxScroll > 0 ? (board.scrollLeft / maxScroll) * thumbRange : 0}px`;
      thumb.style.opacity = ratio < 1 ? "1" : "0";
    }

    board.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(board);
    update();

    // Drag scrollbar thumb
    let dragging = false;
    let startX = 0;
    let startScroll = 0;

    function onMouseDown(e: MouseEvent) {
      dragging = true;
      startX = e.clientX;
      startScroll = board!.scrollLeft;
      thumb!.classList.add("dragging");
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    }

    function onMouseMove(e: MouseEvent) {
      if (!dragging || !board || !thumb) return;
      const ratio =
        board.scrollWidth > board.clientWidth
          ? board.scrollWidth / board.clientWidth
          : 1;
      board.scrollLeft = startScroll + (e.clientX - startX) * ratio;
    }

    function onMouseUp() {
      dragging = false;
      thumb?.classList.remove("dragging");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    thumb.addEventListener("mousedown", onMouseDown);

    return () => {
      board.removeEventListener("scroll", update);
      ro.disconnect();
      thumb.removeEventListener("mousedown", onMouseDown);
    };
  }, [cols.length]);

  // Belt-and-braces: window-level dragend catches stale sessions when the
  // source element unmounts mid-drag (e.g. tree-row drag ends outside a valid
  // zone, Escape key, source card re-renders). Guarantees full cleanup.
  React.useEffect(() => {
    function onWindowDragEnd() {
      dragTaskIdRef.current = null;
      setDragTaskId(null);
      dropIntentRef.current = null;
      setDropIntent(null);
      setMakeChildTarget(null);
      setDragOver(null);
      dragSession.end();
    }
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, []);

  function handleDragStart(e: React.DragEvent, taskId: string) {
    if (!taskId) return;
    dragTaskIdRef.current = taskId;
    setDragTaskId(taskId);
    dragSession.begin(taskId);
    // Reset drop intent — fresh start for each drag session
    dropIntentRef.current = null;
    setDropIntent(null);
    setMakeChildTarget(null);
    setDragOver(null);
    e.dataTransfer.effectAllowed = "move";
    // D1: Firefox requires setData() to initiate HTML5 drag.
    try {
      e.dataTransfer.setData("text/plain", taskId);
    } catch {
      /* test environments may throw */
    }
  }

  function handleDragOver(e: React.DragEvent, colId: string) {
    e.preventDefault();
    setDragOver(colId);
    dropIntentRef.current = { kind: "column", colId };
    setDropIntent(dropIntentRef.current);
    setMakeChildTarget(null);
  }

  function handleCardDragOver(e: React.DragEvent, taskId: string) {
    e.preventDefault();
    e.stopPropagation();
    const dragging = dragTaskIdRef.current;
    if (!dragging) return;
    const wrapperEl = e.currentTarget as HTMLElement;
    // RC1: classify against the card ARTICLE rect, not the wrapper.
    // The pill/indicator mounts inside the wrapper but outside the article,
    // so the article rect is immune to pill presence.
    // RC2: pin center while pill is showing — if makeChildTarget is
    // currently visible for this card, force zone='center' regardless
    // of actual cursor position.
    const pillVisible =
      makeChildTarget?.taskId === taskId && makeChildTarget?.isZone === false;
    const { zone } = classifyForDropIntent(wrapperEl, e.clientY, pillVisible);
    const valid = targetValid(filtered, dragging, taskId);

    if (zone === "center") {
      const task = filtered.find((t) => t.id === taskId);
      dropIntentRef.current = {
        kind: "card",
        taskId,
        // center intent: no position/edgeZone needed
      };
      setDropIntent(dropIntentRef.current);
      if (valid) {
        setMakeChildTarget({ taskId, title: task?.title ?? "", isZone: false });
      } else {
        setMakeChildTarget(null);
      }
    } else {
      // Edge → reorder intent
      const position: "before" | "after" = zone === "top" ? "before" : "after";
      dropIntentRef.current = {
        kind: "card",
        taskId,
        position,
        edgeZone: zone,
      };
      setDropIntent(dropIntentRef.current);
      setMakeChildTarget(null);
    }
  }

  function handleChildrenZoneDragOver(e: React.DragEvent, parentId: string) {
    e.preventDefault();
    e.stopPropagation();
    const dragging = dragTaskIdRef.current;
    if (!dragging) return;
    const valid = targetValid(filtered, dragging, parentId);
    const task = filtered.find((t) => t.id === parentId);
    // Zone intent overwrites any card intent (single ref, no cross-nulling)
    dropIntentRef.current = { kind: "zone", parentId };
    setDropIntent(dropIntentRef.current);
    if (valid) {
      setMakeChildTarget({
        taskId: parentId,
        title: task?.title ?? "",
        isZone: true,
      });
    } else {
      setMakeChildTarget(null);
    }
  }

  function handleChildrenZoneDragLeave(e: React.DragEvent) {
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    // Leaving zone entirely — do NOT null the intent here; the column gap
    // handler or the card handler will overwrite it on next dragover.
    setMakeChildTarget(null);
  }

  function handleDrop(e: React.DragEvent, colId: TaskStatus, colTasks: Task[]) {
    e.preventDefault();
    setDragOver(null);
    // Single ref consume: read once, clear once, act once.
    const intent = dropIntentRef.current;
    dropIntentRef.current = null;
    setDropIntent(null);
    setMakeChildTarget(null);
    // Tree rows begin the dragSession without touching the card ref —
    // prefer the ref, fall back to the session so row drags resolve.
    const dragging = dragTaskIdRef.current ?? dragSession.get();
    dragTaskIdRef.current = null;
    setDragTaskId(null);
    dragSession.end();
    if (!dragging) return;

    if (intent?.kind === "tree-row" && intent.targetId && intent.parentId) {
      if (dragging === intent.targetId) return;
      // Self/descendant guard — mirrors the detail-panel drop handler.
      // Same-parent reorder always passes (parent is neither self nor child).
      if (!canReparent(tasks, dragging, intent.parentId)) return;
      const curParent = getParent(tasks, dragging)?.id ?? null;
      if (curParent === intent.parentId) {
        onTreeReorder?.(
          dragging,
          intent.targetId,
          intent.position ?? "after",
          intent.parentId,
        );
      } else {
        onTreeReparent?.(
          dragging,
          intent.parentId,
          intent.targetId,
          intent.position,
        );
      }
      return;
    }

    if (intent?.kind === "zone" && intent.parentId) {
      if (intent.fromTree) {
        // Tree-row center drop — reparent under the hovered row's task.
        // Use canReparent (allows existing parents) instead of targetValid.
        if (canReparent(tasks, dragging, intent.parentId)) {
          onTreeReparent?.(dragging, intent.parentId);
          return;
        } else {
          // D2: not reparentable — fall through to fallback (no-op) rather
          // than silently returning.
        }
      } else if (onLinkChild) {
        // Card-zone drop — link as child (rejects existing parents).
        const freshValid = targetValid(tasks, dragging, intent.parentId);
        if (freshValid) onLinkChild(dragging, intent.parentId);
        return;
      }
    }

    if (intent?.kind === "card" && intent.taskId) {
      if (!intent.position && onLinkChild) {
        // center → make-child (re-validate against UNFILTERED tasks — fixes E1)
        const freshValid = targetValid(tasks, dragging, intent.taskId);
        if (freshValid) onLinkChild(dragging, intent.taskId);
        return;
      }
      if (intent.position && onReorder) {
        // edge → reorder
        const targetIndex = colTasks.findIndex((t) => t.id === intent.taskId);
        let beforeId: string | null = null;
        let afterId: string | null = null;
        if (intent.position === "before") {
          afterId = intent.taskId;
          beforeId = targetIndex > 0 ? colTasks[targetIndex - 1].id : null;
        } else {
          beforeId = intent.taskId;
          afterId =
            targetIndex < colTasks.length - 1
              ? colTasks[targetIndex + 1].id
              : null;
        }
        onReorder(dragging, colId, beforeId, afterId);
        return;
      }
    }

    // Fallback: dropped on column background → append to bottom
    onDrop(dragging, colId);
  }

  function handleDragEnd() {
    dragTaskIdRef.current = null;
    setDragTaskId(null);
    setDragOver(null);
    dropIntentRef.current = null;
    setDropIntent(null);
    setMakeChildTarget(null);
    dragSession.end();
  }

  /** Tree-row intent writer — overwrites the single ref; row/tree handlers
   * stopPropagation so handleCardDragOver never fights the tree intent.
   * The card pill is suppressed while a tree intent is active (the tree
   * shows its own insertion line / row highlight instead). */
  function handleTreeIntent(intent: DropIntent | null) {
    dropIntentRef.current = intent;
    setDropIntent(intent);
    setMakeChildTarget(null);
  }

  /** Row dragstart mirror — tree rows are not cards, so they set the board
   * drag source explicitly (ref + state + session). */
  function handleTreeRowDragStart(e: React.DragEvent, childId: string) {
    if (!childId) return;
    dragTaskIdRef.current = childId;
    setDragTaskId(childId);
    dragSession.begin(childId);
    dropIntentRef.current = null;
    setDropIntent(null);
    setMakeChildTarget(null);
    setDragOver(null);
    e.dataTransfer.effectAllowed = "move";
    // D1: Firefox requires setData() to initiate HTML5 drag.
    try {
      e.dataTransfer.setData("text/plain", childId);
    } catch {
      /* test environments may throw */
    }
  }

  {
    /* Group all tasks by root: children are rendered under their parent, not as standalone cards */
  }
  const { standalone: allStandalone } = React.useMemo(
    () => groupTasksByRoot(filtered, compareTaskOrder),
    [filtered],
  );

  return (
    <>
      <main
        id="kanban-board"
        ref={boardRef}
        className="flex-1 flex overflow-x-auto overflow-y-hidden"
        style={{ padding: "16px 20px", gap: 16 }}
        onDragEnd={handleDragEnd}
      >
        {cols.map((col) => {
          const colTasks = isLoading
            ? []
            : allStandalone.filter((t) => t.status === col.id);

          // Done column: show latest modified tasks first (reverse order)
          const displayTasks =
            col.id === "done" ? [...colTasks].reverse() : colTasks;

          return (
            <KanbanColumn
              key={col.id}
              col={col}
              tasks={displayTasks}
              allTasks={filtered}
              isLoading={isLoading}
              liveActivities={liveActivities}
              compact={compact}
              /* Highlight the column while its background is hovered. A card or
                 children-zone intent suppresses it so the card-level indicator
                 shows instead; a "column" intent (set by handleDragOver) must
                 NOT suppress it — that regressed the highlight after the
                 drop-intent rewrite. */
              isDragOver={
                dragOver === col.id &&
                dropIntent?.kind !== "card" &&
                dropIntent?.kind !== "zone"
              }
              onDragOver={(e) => handleDragOver(e, col.id)}
              onDrop={(e) => handleDrop(e, col.id, colTasks)}
              onDragLeave={(e) => {
                const related = e.relatedTarget as Node | null;
                if (
                  related &&
                  (e.currentTarget as HTMLElement).contains(related)
                )
                  return;
                setDragOver(null);
                // Do NOT null dropIntentRef here — the drop must consume it.
              }}
              onStatusChange={(taskId, nextStatus) =>
                onDrop(taskId, nextStatus)
              }
              onAddTask={() => onOpenPanel(null, "details", col.id)}
              onOpenTask={onOpenPanel}
              onDragStart={handleDragStart}
              onCardDragOver={handleCardDragOver}
              onChildrenZoneDragOver={handleChildrenZoneDragOver}
              onChildrenZoneDragLeave={handleChildrenZoneDragLeave}
              dropIntent={dropIntent}
              makeChildTarget={makeChildTarget}
              isDragging={dragTaskId !== null}
              treeIntent={dropIntent}
              onTreeIntent={handleTreeIntent}
              onTreeRowDragStart={handleTreeRowDragStart}
            />
          );
        })}
      </main>

      {/* Custom horizontal scrollbar */}
      <div
        id="kanban-scroll-track"
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          height: 6,
          background: "transparent",
          zIndex: 40,
          pointerEvents: "none",
        }}
      >
        <div
          id="kanban-scroll-thumb"
          ref={thumbRef}
          style={{
            position: "absolute",
            top: 1,
            height: 4,
            borderRadius: 2,
            background: "var(--p-border-t)",
            cursor: "pointer",
            pointerEvents: "auto",
            transition: "background 0.15s",
            opacity: 0,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.background =
              "var(--p-text-g)";
          }}
          onMouseLeave={(e) => {
            if (
              !(e.currentTarget as HTMLDivElement).classList.contains(
                "dragging",
              )
            )
              (e.currentTarget as HTMLDivElement).style.background =
                "var(--p-border-t)";
          }}
        />
      </div>
    </>
  );
}

interface ColumnProps {
  col: Column;
  tasks: Task[];
  allTasks: Task[];
  isLoading?: boolean;
  liveActivities?: Map<string, LiveActivity>;
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onStatusChange: (taskId: string, nextStatus: TaskStatus) => void;
  onAddTask: () => void;
  onOpenTask: (task: Task, tab?: "details" | "comments" | "files") => void;
  onDragStart: (e: React.DragEvent, taskId: string) => void;
  onCardDragOver: (e: React.DragEvent, taskId: string) => void;
  onChildrenZoneDragOver: (e: React.DragEvent, parentId: string) => void;
  onChildrenZoneDragLeave: (e: React.DragEvent) => void;
  /** Single drop-intent — all visual states derived from this. */
  dropIntent: DropIntent | null;
  /** Tree-row intent — same single ref, forwarded to card trees. */
  treeIntent: DropIntent | null;
  onTreeIntent: (intent: DropIntent | null) => void;
  onTreeRowDragStart: (e: React.DragEvent, childId: string) => void;
  makeChildTarget: { taskId: string; title: string; isZone: boolean } | null;
  /** Compact view: one-line done-style rows. */
  compact?: boolean;
  /** True while a card drag is active — fit-screen hiding is suspended. */
  isDragging?: boolean;
}

function KanbanColumn({
  col,
  tasks,
  allTasks,
  isLoading,
  liveActivities,
  isDragOver,
  onDragOver,
  onDrop,
  onDragLeave,
  onStatusChange: _onStatusChange, // unused — kept for API compatibility
  onAddTask,
  onOpenTask,
  onDragStart,
  onCardDragOver,
  onChildrenZoneDragOver,
  onChildrenZoneDragLeave,
  dropIntent,
  treeIntent,
  onTreeIntent,
  onTreeRowDragStart,
  makeChildTarget,
  compact,
  isDragging,
}: ColumnProps) {
  const [addHovered, setAddHovered] = React.useState(false);
  // B3: fit-screen — stable declarative overflow handling. The scroll
  // container height is observed; cards are never mutated imperatively.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [colHeight, setColHeight] = React.useState(0);
  const [cardH, setCardH] = React.useState(0);
  React.useEffect(() => {
    // Owner rule: fit-to-screen applies to the done lane only. Other lanes
    // render all tasks with native scrolling and need no measurement.
    if (col.id !== "done") return;
    const el = scrollRef.current;
    if (!el) return;
    setColHeight((prev) => (prev === el.clientHeight ? prev : el.clientHeight));
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setColHeight((prev) =>
          prev === el.clientHeight ? prev : el.clientHeight,
        );
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  React.useEffect(() => {
    if (col.id !== "done") return;
    if (isDragging || isLoading || tasks.length === 0) return;
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      const first = el.querySelector("[data-task-id]") as HTMLElement | null;
      if (!first || first.offsetHeight <= 0) return;
      setCardH((prev) =>
        prev === first.offsetHeight ? prev : first.offsetHeight,
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [tasks.length, isDragging, isLoading]);

  const dotClass = col.id === "in-progress" ? "sd-inprogress" : `sd-${col.id}`;

  // DONE_LIMIT is only a fallback cap for the done lane before measurement
  // arrives. Once measured, the done lane fits to the real screen height.
  const DONE_LIMIT = 10;
  const isDone = col.id === "done";
  const CHIP_H = 34;
  const COLUMN_GAP = 5;
  const measured =
    isDone && cardH > 0 && colHeight > 0 && !isDragging && !isLoading;
  const fitCount = measured
    ? Math.max(
        1,
        Math.floor(
          Math.max(0, colHeight - CHIP_H + COLUMN_GAP) / (cardH + COLUMN_GAP),
        ),
      )
    : DONE_LIMIT;
  // Owner rule: only the done lane fits to screen; every other lane renders
  // all tasks with normal scrolling.
  const visibleTasks = isDone ? tasks.slice(0, fitCount) : tasks;
  const overflow = tasks.length - visibleTasks.length;

  return (
    <section
      className="board-column"
      data-column-id={col.id}
      style={{
        ...(isDragOver
          ? {
              outline: `2px solid ${col.color}55`,
              outlineOffset: -2,
              background: col.accent,
              boxShadow: `0 0 12px ${col.color}22`,
              transition: "background 0.15s, box-shadow 0.15s, outline 0.15s",
            }
          : {
              transition: "background 0.15s, box-shadow 0.15s, outline 0.15s",
            }),
        borderRadius: 8,
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Column header */}
      <div
        className="column-header"
        style={{
          background: col.accent,
          borderColor: `color-mix(in srgb, ${col.color} 30%, transparent)`,
        }}
      >
        <div className={`status-dot ${dotClass}`} />
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: col.id === "done" ? `${col.color}b3` : col.color,
          }}
        >
          {col.label}
          {isLoading ? "" : ` · ${tasks.length}`}
        </span>
        <span style={{ marginLeft: "auto" }} />
        <button
          type="button"
          title={`Add task to ${col.label}`}
          style={{
            width: 20,
            height: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            border: "none",
            background: "transparent",
            color: addHovered ? col.color : "var(--p-text-g)",
            cursor: "pointer",
            transition: "color .15s",
            padding: 0,
          }}
          onMouseEnter={() => setAddHovered(true)}
          onMouseLeave={() => setAddHovered(false)}
          onClick={onAddTask}
        >
          <Plus style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {/* Cards */}
      <div className="column-scroll" data-status={col.id} ref={scrollRef}>
        {isLoading ? (
          Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <SkeletonCard key={i} />
          ))
        ) : tasks.length === 0 ? (
          <div
            style={{
              border: "1px dashed var(--p-border-t)",
              borderRadius: 8,
              padding: "10px 8px",
              fontSize: 11,
              color: "var(--p-text-f)",
              textAlign: "center",
            }}
          >
            No tasks in {col.label.toLowerCase()}.
          </div>
        ) : (
          <>
            {visibleTasks.map((task) => {
              const isCardTarget =
                dropIntent?.kind === "card" && dropIntent.taskId === task.id;
              const isCenterTarget = isCardTarget && !dropIntent!.position;
              const isBlockedTarget = isCenterTarget && !makeChildTarget;
              const isZoneTarget =
                dropIntent?.kind === "zone" && dropIntent.parentId === task.id;
              const isReorderTarget = isCardTarget && dropIntent!.position;
              return (
                <div
                  key={task.id}
                  style={{ position: "relative" }}
                  onDragOver={(e) => onCardDragOver(e, task.id)}
                  className={
                    isCenterTarget
                      ? "dnd-drop-center"
                      : isBlockedTarget
                        ? "dnd-drop-blocked"
                        : isZoneTarget
                          ? "dnd-zone-hover"
                          : undefined
                  }
                >
                  {isReorderTarget && dropIntent!.position === "before" && (
                    <div
                      style={{
                        height: 2,
                        borderRadius: 1,
                        background: col.color,
                        margin: "2px 0",
                      }}
                    />
                  )}
                  <TaskCard
                    task={task}
                    col={col}
                    liveActivity={liveActivities?.get(task.id)}
                    compact={compact}
                    allTasks={allTasks}
                    onOpen={onOpenTask}
                    onOpenChild={onOpenTask}
                    onDragStart={onDragStart}
                    isDragging={isDragging}
                    onChildrenZoneDragOver={
                      isDragging
                        ? (e) => onChildrenZoneDragOver(e, task.id)
                        : undefined
                    }
                    onChildrenZoneDragLeave={
                      isDragging ? onChildrenZoneDragLeave : undefined
                    }
                    treeIntent={treeIntent}
                    onTreeIntent={onTreeIntent}
                    onTreeRowDragStart={onTreeRowDragStart}
                  />
                  {isReorderTarget && dropIntent!.position === "after" && (
                    <div
                      style={{
                        height: 2,
                        borderRadius: 1,
                        background: col.color,
                        margin: "2px 0",
                      }}
                    />
                  )}
                  {/* Make-child pill — appears below the card. Suppressed
                      while a tree intent is active (the tree shows its own
                      insertion line / row highlight) and null-guarded so an
                      invalid center target can never crash the render. */}
                  {isCenterTarget &&
                    makeChildTarget &&
                    dropIntent?.kind !== "tree-row" && (
                      <div
                        className="dnd-make-child-pill"
                        role="status"
                        aria-label={`Make child of ${makeChildTarget.title}`}
                      >
                        ↳ Make child of &ldquo;{makeChildTarget.title}&rdquo;
                      </div>
                    )}
                </div>
              );
            })}
            {overflow > 0 && (
              <div
                data-fit-chip
                style={{
                  background: "var(--p-card)",
                  border: "2px dashed var(--p-border-t)",
                  borderRadius: 10,
                  padding: "11px 13px",
                  fontSize: 12,
                  color: "var(--p-text-g)",
                  textAlign: "center",
                  lineHeight: 1.4,
                  opacity: 0.7,
                }}
              >
                +{overflow} more
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
