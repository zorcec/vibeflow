import React from "react";
import type { BoardItem, BoardHandlers } from "./types";
import { TaskCard } from "./TaskCard";

interface Props {
  board: BoardItem;
  handlers: BoardHandlers;
}

export function Board({ board, handlers }: Props) {
  return (
    <div data-board-id={board.id}>
      <h2>{board.name}</h2>
      {board.tasks.map((t) => (
        <TaskCard key={t.id} task={t} handlers={handlers} />
      ))}
    </div>
  );
}
