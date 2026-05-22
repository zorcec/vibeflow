import React from "react";
import type { TaskItem, BoardHandlers } from "./types";
import { TaskCard } from "./TaskCard";

interface Props {
  tasks: TaskItem[];
  handlers: BoardHandlers;
}

export function TaskList({ tasks, handlers }: Props) {
  if (tasks.length === 0) {
    return <p style={{ opacity: 0.5 }}>No tasks yet.</p>;
  }

  return (
    <div>
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} handlers={handlers} />
      ))}
    </div>
  );
}
