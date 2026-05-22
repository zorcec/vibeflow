"use client";

import React from "react";
import { Plus } from "lucide-react";
import type { KanbanTask, KanbanColumn, KanbanHandlers } from "./types";
import { KanbanCard } from "./KanbanCard";

interface Props {
  tasks: KanbanTask[];
  columns: KanbanColumn[];
  handlers: KanbanHandlers;
  searchQuery?: string;
}

export function KanbanBoard({ tasks, columns, handlers, searchQuery = "" }: Props) {
  const [dragTaskId, setDragTaskId] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState<string | null>(null);
  const [addingIn, setAddingIn] = React.useState<string | null>(null);
  const [newTitle, setNewTitle] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const filtered = searchQuery
    ? tasks.filter(
        (t) =>
          (t.title ?? "").toLowerCase().includes(searchQuery.toLowerCase()) ||
          (t.description ?? "").toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : tasks;

  React.useEffect(() => {
    if (addingIn) inputRef.current?.focus();
  }, [addingIn]);

  function handleDragStart(_e: React.DragEvent, taskId: string) {
    setDragTaskId(taskId);
  }

  function handleDrop(colId: string) {
    if (dragTaskId && dragTaskId !== colId) {
      handlers.onUpdate(dragTaskId, { status: colId });
    }
    setDragTaskId(null);
    setDragOver(null);
  }

  async function handleAddSubmit(colId: string) {
    const title = newTitle.trim();
    if (!title) {
      setAddingIn(null);
      return;
    }
    await handlers.onCreate(colId, title);
    setNewTitle("");
    setAddingIn(null);
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "16px 20px",
        overflowX: "auto",
        overflowY: "hidden",
        flex: 1,
        minHeight: 0,
        scrollbarWidth: "thin",
        scrollbarColor: "var(--p-border-t) transparent",
      }}
    >
      {columns.map((col) => {
        const colTasks = filtered.filter((t) => t.status === col.id);
        const isOver = dragOver === col.id;

        return (
          <div
            key={col.id}
            style={{
              flexShrink: 0,
              width: 260,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              minHeight: 0,
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(col.id);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={() => handleDrop(col.id)}
          >
            {/* Column header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 10px",
                borderRadius: 8,
                background: "var(--p-surface)",
                border: `1px solid ${isOver ? col.color : "var(--p-border)"}`,
                transition: "border-color .15s",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: col.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 11, fontWeight: 600, color: col.color, flex: 1 }}>
                {col.label}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--p-text-g)",
                  background: "var(--p-hover)",
                  borderRadius: 4,
                  padding: "1px 6px",
                }}
              >
                {colTasks.length}
              </span>
            </div>

            {/* Cards */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 5,
                paddingBottom: 8,
                minHeight: 0,
                borderRadius: 8,
                border: isOver ? `2px dashed ${col.color}40` : "2px solid transparent",
                padding: isOver ? "4px" : "2px",
                transition: "border .12s, padding .12s",
              }}
            >
              {colTasks.map((task) => (
                <KanbanCard
                  key={task.id}
                  task={task}
                  col={col}
                  handlers={handlers}
                  onDragStart={handleDragStart}
                />
              ))}

              {/* Add task input */}
              {addingIn === col.id ? (
                <div
                  style={{
                    background: "var(--p-card)",
                    border: "1px solid var(--p-border-s)",
                    borderRadius: 8,
                    padding: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <input
                    ref={inputRef}
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="Task title…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleAddSubmit(col.id);
                      if (e.key === "Escape") {
                        setAddingIn(null);
                        setNewTitle("");
                      }
                    }}
                    style={{
                      background: "var(--p-input)",
                      border: "1px solid var(--p-border-t)",
                      borderRadius: 6,
                      padding: "5px 8px",
                      fontSize: 12,
                      color: "var(--p-text)",
                      outline: "none",
                      width: "100%",
                      boxSizing: "border-box",
                    }}
                  />
                  <div style={{ display: "flex", gap: 5 }}>
                    <button
                      onClick={() => void handleAddSubmit(col.id)}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        borderRadius: 6,
                        background: "var(--p-blue)",
                        border: "none",
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      Add
                    </button>
                    <button
                      onClick={() => {
                        setAddingIn(null);
                        setNewTitle("");
                      }}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 6,
                        background: "var(--p-hover)",
                        border: "1px solid var(--p-border)",
                        color: "var(--p-text-m)",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setAddingIn(col.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "5px 8px",
                    borderRadius: 8,
                    border: "1px dashed var(--p-border)",
                    background: "transparent",
                    color: "var(--p-text-g)",
                    fontSize: 11,
                    cursor: "pointer",
                    transition: "all .12s",
                    width: "100%",
                  }}
                  onMouseEnter={(e) => {
                    const el = e.currentTarget;
                    el.style.borderColor = col.color;
                    el.style.color = col.color;
                    el.style.background = col.accent ?? "transparent";
                  }}
                  onMouseLeave={(e) => {
                    const el = e.currentTarget;
                    el.style.borderColor = "var(--p-border)";
                    el.style.color = "var(--p-text-g)";
                    el.style.background = "transparent";
                  }}
                >
                  <Plus style={{ width: 12, height: 12 }} />
                  Add task
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
