import React from 'react';
import { Plus, Play, X } from 'lucide-react';
import type { Task, Column, TaskStatus, LiveActivity, AgentStatus } from '../types';
import { TaskCard } from './TaskCard';
import { compareTaskOrder, computeReorder, generateSortKeyBetween } from '../utils';

const COLUMNS: Column[] = [
  { id: 'backlog',      label: 'Backlog',      color: 'var(--p-text-f)',    accent: 'color-mix(in srgb, var(--p-text-g) 20%, transparent)' },
  { id: 'todo',         label: 'Todo',         color: 'var(--p-amber)',     accent: 'color-mix(in srgb, var(--p-amber) 12%, transparent)' },
  { id: 'in-progress',  label: 'In Progress',  color: 'var(--p-blue)',      accent: 'color-mix(in srgb, var(--p-blue) 12%, transparent)', glow: true },
  { id: 'review',       label: 'Review',       color: 'var(--p-purple)',    accent: 'color-mix(in srgb, var(--p-purple) 12%, transparent)' },
  { id: 'done',         label: 'Done',         color: 'var(--p-green)',     accent: 'color-mix(in srgb, var(--p-green) 10%, transparent)' },
];

export { COLUMNS };

const SKELETON_COUNT = 3;

function SkeletonCard() {
  return (
    <div style={{
      borderRadius: 8, border: '1px solid var(--p-border-t)', padding: '10px 12px',
      background: 'var(--p-bg-2)', marginBottom: 6,
      animation: 'skeleton-pulse 1.5s ease-in-out infinite',
    }}>
      <div style={{ height: 12, borderRadius: 4, background: 'var(--p-border-s)', width: '75%', marginBottom: 8 }} />
      <div style={{ height: 10, borderRadius: 4, background: 'var(--p-border-s)', width: '50%', marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ height: 18, borderRadius: 10, background: 'var(--p-border-s)', width: 48 }} />
        <div style={{ height: 18, borderRadius: 10, background: 'var(--p-border-s)', width: 36 }} />
      </div>
    </div>
  );
}

interface DropTarget {
  taskId: string;
  position: 'before' | 'after';
}

interface Props {
  tasks: Task[];
  visibleCols: TaskStatus[];
  searchQuery: string;
  isLoading?: boolean;
  liveActivities?: Map<string, LiveActivity>;
  onOpenPanel: (task: Task | null, tab?: 'details' | 'comments' | 'files' | 'agent', columnId?: TaskStatus) => void;
  onDrop: (taskId: string, newStatus: TaskStatus) => void;
  /** Called when a task is dropped at a specific position within/across columns. */
  onReorder?: (taskId: string, newStatus: TaskStatus, beforeId: string | null, afterId: string | null, explicitSortKey?: string) => void;
  /** Multi-select mode state. */
  selectMode?: boolean;
  /** Currently selected task IDs. */
  selectedTaskIds?: Set<string>;
  /** Toggle selection of a task. */
  onToggleSelect?: (taskId: string) => void;
  /** Called when a long-press activates select mode. */
  onEnterSelectMode?: (taskId: string) => void;
  /** Map of taskId -> agent status for visual indicators. */
  agentStatuses?: Map<string, AgentStatus>;
  /** Called when the user clicks "Run Agents" on the multi-select toolbar. */
  onRunSelectedAgents?: (taskIds: string[]) => void;
  /** Called when the user exits multi-select mode. */
  onExitSelectMode?: () => void;
  /** When false, agent-related UI is hidden. */
  experimentalAgents?: boolean;
}

export function KanbanBoard({ tasks, visibleCols, searchQuery, isLoading, liveActivities, onOpenPanel, onDrop, onReorder, selectMode, selectedTaskIds, onToggleSelect, onEnterSelectMode, agentStatuses, onRunSelectedAgents, onExitSelectMode, experimentalAgents }: Props) {
  const boardRef = React.useRef<HTMLElement>(null);
  const thumbRef = React.useRef<HTMLDivElement>(null);
  const [dragTaskId, setDragTaskId] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState<string | null>(null);
  const [cardDropTarget, setCardDropTarget] = React.useState<DropTarget | null>(null);
  // Refs mirror the above states so handleDrop always reads the latest value synchronously.
  // React state updates are async; reading from a stale closure causes cardDropTarget to be null
  // at drop time when dragleave briefly clears it while moving between cards through the gap.
  const dragTaskIdRef = React.useRef<string | null>(null);
  const cardDropTargetRef = React.useRef<DropTarget | null>(null);
  // Multi-select drag: when dragging a selected task in select mode, all selected tasks move together.
  const [multiDragIds, setMultiDragIds] = React.useState<string[]>([]);
  const multiDragIdsRef = React.useRef<string[]>([]);

  const filtered = searchQuery
    ? tasks.filter(t =>
        (t.title ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (t.description ?? '').toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : tasks;

  const cols = COLUMNS.filter(c => visibleCols.includes(c.id));

  // Custom scrollbar sync
  React.useEffect(() => {
    const board = boardRef.current;
    const thumb = thumbRef.current;
    if (!board || !thumb) return;

    function update() {
      if (!board || !thumb) return;
      const ratio = board.scrollWidth > board.clientWidth
        ? board.clientWidth / board.scrollWidth
        : 1;
      const thumbWidth = Math.max(40, board.clientWidth * ratio);
      thumb.style.width = `${thumbWidth}px`;
      const maxScroll = board.scrollWidth - board.clientWidth;
      const thumbRange = board.clientWidth - thumbWidth;
      thumb.style.left = `${maxScroll > 0 ? (board.scrollLeft / maxScroll) * thumbRange : 0}px`;
      thumb.style.opacity = ratio < 1 ? '1' : '0';
    }

    board.addEventListener('scroll', update);
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
      thumb!.classList.add('dragging');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    }

    function onMouseMove(e: MouseEvent) {
      if (!dragging || !board || !thumb) return;
      const ratio = board.scrollWidth > board.clientWidth
        ? board.scrollWidth / board.clientWidth : 1;
      board.scrollLeft = startScroll + (e.clientX - startX) * ratio;
    }

    function onMouseUp() {
      dragging = false;
      thumb?.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    thumb.addEventListener('mousedown', onMouseDown);

    return () => {
      board.removeEventListener('scroll', update);
      ro.disconnect();
      thumb.removeEventListener('mousedown', onMouseDown);
    };
  }, [cols.length]);

  function handleDragStart(e: React.DragEvent, taskId: string) {
    dragTaskIdRef.current = taskId;
    setDragTaskId(taskId);
    e.dataTransfer.effectAllowed = 'move';
    // Multi-select drag: if the dragged task is selected, drag all selected tasks together.
    if (selectMode && selectedTaskIds?.has(taskId) && (selectedTaskIds.size ?? 0) > 1) {
      const ids = Array.from(selectedTaskIds);
      multiDragIdsRef.current = ids;
      setMultiDragIds(ids);
    } else {
      multiDragIdsRef.current = [];
      setMultiDragIds([]);
    }
  }

  function handleDragOver(e: React.DragEvent, colId: string) {
    e.preventDefault();
    setDragOver(colId);
  }

  function handleCardDragOver(e: React.DragEvent, taskId: string) {
    e.preventDefault();
    e.stopPropagation(); // prevent column-level dragover from overriding
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const newTarget = { taskId, position };
    cardDropTargetRef.current = newTarget;
    setCardDropTarget(prev =>
      prev?.taskId === taskId && prev.position === position ? prev : newTarget,
    );
  }

  function handleDrop(e: React.DragEvent, colId: TaskStatus, colTasks: Task[]) {
    e.preventDefault();
    setDragOver(null);
    // Read from ref — always current even if React state update from dragleave briefly cleared state
    const target = cardDropTargetRef.current;
    cardDropTargetRef.current = null;
    setCardDropTarget(null);
    const dragging = dragTaskIdRef.current;
    dragTaskIdRef.current = null;
    setDragTaskId(null);
    const multiIds = multiDragIdsRef.current;
    multiDragIdsRef.current = [];
    setMultiDragIds([]);
    if (!dragging) return;

    // Multi-select drop: reorder all selected tasks and place them at the drop position,
    // preserving their original relative order.
    if (multiIds.length > 1 && onReorder) {
      // Sort selected tasks by their current order so relative order is preserved
      const sortedMultiIds = multiIds
        .map(id => tasks.find(t => t.id === id)!)
        .filter(Boolean)
        .sort(compareTaskOrder)
        .map(t => t.id);

      // Build the target column with selected tasks inserted at the drop position
      const targetColTasks = tasks
        .filter(t => t.status === colId)
        .sort(compareTaskOrder);

      // Remove selected tasks from target column (they may already be in it)
      const filteredTargetTasks = targetColTasks.filter(t => !multiIds.includes(t.id));

      // Determine insertion index based on drop target
      let insertIndex: number;
      if (target) {
        const targetIndex = filteredTargetTasks.findIndex(t => t.id === target.taskId);
        insertIndex = target.position === 'before' ? targetIndex : targetIndex + 1;
      } else {
        insertIndex = filteredTargetTasks.length;
      }

      // Build the final column array with selected tasks inserted
      const selectedTasks = sortedMultiIds.map(id => tasks.find(t => t.id === id)!);
      const finalTasks = [
        ...filteredTargetTasks.slice(0, insertIndex),
        ...selectedTasks,
        ...filteredTargetTasks.slice(insertIndex),
      ];

      // Compute sort keys incrementally using a mutable key map so each selected
      // task gets a key relative to the previously-moved task's new key.
      const keyMap = new Map<string, string | null>();
      for (const t of finalTasks) keyMap.set(t.id, t.sortKey ?? null);

      for (let i = 0; i < finalTasks.length; i++) {
        const task = finalTasks[i];
        if (!multiIds.includes(task.id)) continue;
        const beforeId = i > 0 ? finalTasks[i - 1].id : null;
        const afterId = i < finalTasks.length - 1 ? finalTasks[i + 1].id : null;
        const beforeKey = beforeId ? keyMap.get(beforeId) ?? null : null;
        const afterKey = afterId ? keyMap.get(afterId) ?? null : null;
        const newSortKey = generateSortKeyBetween(beforeKey, afterKey);
        keyMap.set(task.id, newSortKey);
        onReorder(task.id, colId, beforeId, afterId, newSortKey);
      }
      return;
    }

    if (onReorder && target) {
      // Dropped onto a specific card — compute before/after neighbours
      const targetIndex = colTasks.findIndex(t => t.id === target.taskId);
      let beforeId: string | null = null;
      let afterId: string | null = null;
      if (target.position === 'before') {
        afterId = target.taskId;
        beforeId = targetIndex > 0 ? colTasks[targetIndex - 1].id : null;
      } else {
        beforeId = target.taskId;
        afterId = targetIndex < colTasks.length - 1 ? colTasks[targetIndex + 1].id : null;
      }
      onReorder(dragging, colId, beforeId, afterId);
    } else {
      // Dropped on column background — append to bottom
      onDrop(dragging, colId);
    }
  }

  function handleDragEnd() {
    dragTaskIdRef.current = null;
    setDragTaskId(null);
    setDragOver(null);
    cardDropTargetRef.current = null;
    setCardDropTarget(null);
    multiDragIdsRef.current = [];
    setMultiDragIds([]);
  }

  const selectedCount = selectedTaskIds?.size ?? 0;

  return (
    <>
      <main
        id="kanban-board"
        ref={boardRef}
        className="flex-1 flex overflow-x-auto overflow-y-hidden"
        style={{ padding: '16px 20px', gap: 16 }}
        onDragEnd={handleDragEnd}
      >
        {cols.map((col) => {
          const colTasks = isLoading
            ? []
            : filtered
                .filter(t => t.status === col.id)
                .sort(compareTaskOrder);

          // Done column: show latest modified tasks first (reverse order)
          const displayTasks = col.id === 'done' ? [...colTasks].reverse() : colTasks;

          return (
            <KanbanColumn
              key={col.id}
              col={col}
              tasks={displayTasks}
              isLoading={isLoading}
              liveActivities={liveActivities}
              isDragOver={dragOver === col.id && !cardDropTarget}
              onDragOver={(e) => handleDragOver(e, col.id)}
              onDrop={(e) => handleDrop(e, col.id, colTasks)}
              onDragLeave={(e) => {
                // Only clear when drag actually leaves the column boundary, not when moving
                // between child elements (cards). Moving from the inter-card gap to a card
                // fires dragleave on the section — check relatedTarget to avoid false clears.
                const related = e.relatedTarget as Node | null;
                if (related && (e.currentTarget as HTMLElement).contains(related)) return;
                setDragOver(null);
                cardDropTargetRef.current = null;
                setCardDropTarget(null);
              }}
              onStatusChange={(taskId, nextStatus) => onDrop(taskId, nextStatus)}
              onAddTask={() => onOpenPanel(null, 'details', col.id)}
              onOpenTask={onOpenPanel}
              onDragStart={handleDragStart}
              onCardDragOver={handleCardDragOver}
              cardDropTarget={cardDropTarget}
              selectMode={selectMode}
              selectedTaskIds={selectedTaskIds}
              onToggleSelect={onToggleSelect}
              onEnterSelectMode={onEnterSelectMode}
              agentStatuses={experimentalAgents === true ? agentStatuses : undefined}
              experimentalAgents={experimentalAgents}
              multiDragIds={multiDragIds}
            />
          );
        })}
      </main>

      {/* Multi-select floating toolbar */}
      {experimentalAgents === true && selectMode && selectedCount > 0 && (
        <div
          style={{
            position: 'fixed', bottom: 14, left: '50%', transform: 'translateX(-50%)',
            zIndex: 45, display: 'flex', alignItems: 'center', gap: 10,
            background: 'var(--p-surface)', border: '1px solid var(--p-border-s)',
            borderRadius: 10, padding: '8px 14px',
            boxShadow: '0 -4px 24px rgba(0,0,0,0.4)',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--p-text-m)', fontWeight: 500 }}>
            <strong style={{ color: 'var(--p-text)' }}>{selectedCount}</strong> task{selectedCount !== 1 ? 's' : ''} selected
          </span>
          <div style={{ width: 1, height: 16, background: 'var(--p-border)' }} />
          <button
            onClick={() => onRunSelectedAgents?.(Array.from(selectedTaskIds!))}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '5px 12px', borderRadius: 6, border: '1px solid var(--p-purple)',
              background: 'var(--p-purple)', color: '#fff', fontSize: 11, fontWeight: 600,
              cursor: 'pointer', transition: 'background .12s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#9333ea'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--p-purple)'; }}
          >
            <Play style={{ width: 10, height: 10 }} />
            Run Agents ({selectedCount})
          </button>
          <button
            onClick={onExitSelectMode}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', borderRadius: 6, border: '1px solid var(--p-border)',
              background: 'transparent', color: 'var(--p-text-m)', fontSize: 11,
              cursor: 'pointer', transition: 'all .12s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--p-border-s)'; e.currentTarget.style.color = 'var(--p-text)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--p-border)'; e.currentTarget.style.color = 'var(--p-text-m)'; }}
          >
            <X style={{ width: 10, height: 10 }} />
            Clear
          </button>
        </div>
      )}

      {/* Custom horizontal scrollbar */}
      <div
        id="kanban-scroll-track"
        style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: 6, background: 'transparent', zIndex: 40, pointerEvents: 'none' }}
      >
        <div
          id="kanban-scroll-thumb"
          ref={thumbRef}
          style={{ position: 'absolute', top: 1, height: 4, borderRadius: 2, background: 'var(--p-border-t)', cursor: 'pointer', pointerEvents: 'auto', transition: 'background 0.15s', opacity: 0 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--p-text-g)'; }}
          onMouseLeave={(e) => { if (!(e.currentTarget as HTMLDivElement).classList.contains('dragging')) (e.currentTarget as HTMLDivElement).style.background = 'var(--p-border-t)'; }}
        />
      </div>
    </>
  );
}

interface ColumnProps {
  col: Column;
  tasks: Task[];
  isLoading?: boolean;
  liveActivities?: Map<string, LiveActivity>;
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onStatusChange: (taskId: string, nextStatus: TaskStatus) => void;
  onAddTask: () => void;
  onOpenTask: (task: Task, tab?: 'details' | 'comments' | 'files' | 'agent') => void;
  onDragStart: (e: React.DragEvent, taskId: string) => void;
  onCardDragOver: (e: React.DragEvent, taskId: string) => void;
  cardDropTarget: DropTarget | null;
  selectMode?: boolean;
  selectedTaskIds?: Set<string>;
  onToggleSelect?: (taskId: string) => void;
  /** Called when a long-press activates select mode. */
  onEnterSelectMode?: (taskId: string) => void;
  agentStatuses?: Map<string, AgentStatus>;
  /** When false, agent-related UI is hidden. */
  experimentalAgents?: boolean;
  /** Task IDs being dragged together in multi-select mode. */
  multiDragIds?: string[];
}

function KanbanColumn({ col, tasks, isLoading, liveActivities, isDragOver, onDragOver, onDrop, onDragLeave, onStatusChange, onAddTask, onOpenTask, onDragStart, onCardDragOver, cardDropTarget, selectMode, selectedTaskIds, onToggleSelect, onEnterSelectMode, agentStatuses, experimentalAgents, multiDragIds }: ColumnProps) {
  const [addHovered, setAddHovered] = React.useState(false);
  const dotClass = col.id === 'in-progress' ? 'sd-inprogress' : `sd-${col.id}`;

  const DONE_LIMIT = 20;
  const isDone = col.id === 'done';
  const hiddenCount = isDone && tasks.length > DONE_LIMIT ? tasks.length - DONE_LIMIT : 0;
  const visibleTasks = isDone ? tasks.slice(0, DONE_LIMIT) : tasks;

  return (
    <section
      className="board-column"
      data-column-id={col.id}
      style={{ outline: isDragOver ? `2px dashed ${col.color}66` : undefined, outlineOffset: -2, borderRadius: 8 }}
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
        <span style={{ fontSize: 12, fontWeight: 600, color: col.id === 'done' ? `${col.color}b3` : col.color }}>
          {col.label}{isLoading ? '' : ` · ${tasks.length}`}
        </span>
        <span style={{ marginLeft: 'auto' }} />
        <button
          type="button"
          title={`Add task to ${col.label}`}
          style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: 'none', background: 'transparent', color: addHovered ? col.color : 'var(--p-text-g)', cursor: 'pointer', transition: 'color .15s', padding: 0 }}
          onMouseEnter={() => setAddHovered(true)}
          onMouseLeave={() => setAddHovered(false)}
          onClick={onAddTask}
        >
          <Plus style={{ width: 14, height: 14 }} />
        </button>
      </div>

      {/* Cards */}
      <div
        className="column-scroll"
        data-status={col.id}
      >
        {isLoading ? (
          Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <SkeletonCard key={i} />
          ))
        ) : tasks.length === 0 ? (
          <div style={{ border: '1px dashed var(--p-border-t)', borderRadius: 8, padding: '10px 8px', fontSize: 11, color: 'var(--p-text-f)', textAlign: 'center' }}>
            No tasks in {col.label.toLowerCase()}.
          </div>
        ) : (
          <>
            {visibleTasks.map(task => (
              <div
                key={task.id}
                style={{ position: 'relative' }}
                onDragOver={(e) => onCardDragOver(e, task.id)}
              >
                {cardDropTarget?.taskId === task.id && cardDropTarget.position === 'before' && (
                  <div style={{ height: 2, borderRadius: 1, background: col.color, margin: '2px 0' }} />
                )}
                <TaskCard
                  task={task}
                  col={col}
                  liveActivity={liveActivities?.get(task.id)}
                  onOpen={onOpenTask}
                  onDragStart={onDragStart}
                  selectMode={selectMode}
                  selected={selectedTaskIds?.has(task.id)}
                  onToggleSelect={onToggleSelect}
                  onEnterSelectMode={onEnterSelectMode}
                  agentStatus={agentStatuses?.get(task.id)}
                  experimentalAgents={experimentalAgents}
                  multiDragCount={multiDragIds && multiDragIds.length > 1 && multiDragIds[0] === task.id ? multiDragIds.length : undefined}
                />
                {cardDropTarget?.taskId === task.id && cardDropTarget.position === 'after' && (
                  <div style={{ height: 2, borderRadius: 1, background: col.color, margin: '2px 0' }} />
                )}
              </div>
            ))}
            {hiddenCount > 0 && (
              <div
                style={{
                  margin: '4px 0 2px',
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px dashed var(--p-border-t)',
                  fontSize: 11,
                  color: 'var(--p-text-g)',
                  textAlign: 'center',
                  lineHeight: 1.4,
                }}
              >
                +{hiddenCount} older {hiddenCount === 1 ? 'task' : 'tasks'} not shown
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
