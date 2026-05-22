import React from "react";
import type { TaskItem, BoardHandlers } from "./types";

interface Props {
  task: TaskItem;
  handlers: BoardHandlers;
}

export function TaskCard({ task }: Props) {
  return (
    <div data-task-id={task.id} data-status={task.status}>
      <span>{task.title}</span>
      {task.description && (
        <p style={{ opacity: 0.7, fontSize: "0.875rem" }}>{task.description}</p>
      )}
    </div>
  );
}
