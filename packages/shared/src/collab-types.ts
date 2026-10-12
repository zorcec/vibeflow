export type UserId = string;
export type WorkspaceId = string;
export type RoomKey = string; // workspace:{id}:project:{id}:board:{id}

export interface UserPresence {
  userId: UserId;
  name: string;
  color: string; // deterministic HSL hash of userId
  currentPath: string;
}

/**
 * Per-task presence area: which part of a task a user is in.
 * `null` (taskId null) means the user is not in any task.
 * Unknown areas degrade to task-level presence — the type is intentionally
 * narrow on send and tolerant on receive.
 */
export type PresenceArea =
  | "description"
  | "comments"
  | "files"
  | "relations"
  | "header";

/**
 * Base64-encoded Yjs payload (state vector, update, or awareness update).
 * Base64 keeps every doc message JSON-safe on the `server-event` channel;
 * the shared surface never imports Yjs (the CLI bundle stays Yjs-free).
 */
export type Base64Bytes = string;

/** Client → server: open (or re-open) a task description doc. */
export interface DocJoinRequest {
  type: "doc.join";
  boardId: string;
  taskId: string;
  /** This replica's state vector — empty on first join, current on rejoin. */
  sv: Base64Bytes;
}

/** Client → server: state-vector diff reply (step 2 only; apply on receipt). */
export interface DocSyncMessage {
  type: "doc.sync";
  boardId: string;
  taskId: string;
  step: 2;
  data: Base64Bytes;
}

/** Client → server: one local Yjs update. Relayed to the other holders. */
export interface DocUpdateMessage {
  type: "doc.update";
  boardId: string;
  taskId: string;
  update: Base64Bytes;
}

/** Client → server: one encoded y-protocols awareness update (cursor). */
export interface DocAwarenessMessage {
  type: "awareness.update";
  boardId: string;
  taskId: string;
  /** y-protocols awareness client id of the sender. */
  clientId: number;
  update: Base64Bytes;
}

/** Client → server: close a task description doc (flushes on last leave). */
export interface DocLeaveMessage {
  type: "doc.leave";
  boardId: string;
  taskId: string;
}

export type DocClientMessage =
  | DocJoinRequest
  | DocSyncMessage
  | DocUpdateMessage
  | DocAwarenessMessage
  | DocLeaveMessage;

export type ClientEvent =
  | { type: "presence.join"; roomKey: RoomKey; user: UserPresence }
  | {
      type: "presence.update";
      roomKey: RoomKey;
      taskId: string | null;
      area: PresenceArea | null;
    }
  | { type: "presence.leave"; roomKey: RoomKey }
  | { type: "cursor.update"; roomKey: RoomKey; x: number; y: number }
  | {
      type: "typing.update";
      roomKey: RoomKey;
      targetId: string;
      active: boolean;
      state?: 'viewing' | 'editing';
      area?: PresenceArea | null;
    }
  | { type: "task.subscribe"; workspaceId: string }
  | { type: "task.unsubscribe"; workspaceId: string };

export type ServerEvent =
  | { type: "presence.join"; user: UserPresence }
  | {
      type: "presence.update";
      userId: UserId;
      name: string;
      color: string;
      taskId: string | null;
      area: PresenceArea | null;
    }
  | { type: "presence.leave"; userId: UserId }
  | { type: "cursor.update"; userId: UserId; x: number; y: number }
  /**
   * Server → client: state-vector diff (step 2, apply) or vector (step 1,
   * reply step 2). `epoch` is the doc's reseed generation: when it differs
   * from the client's, the server doc was destroyed and reseeded since the
   * client last synced, so the client must reset to this state instead of
   * merging (same text, new history — merging would duplicate the seed).
   */
  | { type: "doc.sync"; taskId: string; step: 1 | 2; data: Base64Bytes; epoch: number }
  /** Server → client: another holder's update (already applied server-side). */
  | { type: "doc.update"; taskId: string; update: Base64Bytes; actorId: UserId }
  /**
   * Server → client: cursor update. `update` carries one encoded
   * y-protocols awareness update; `removed` carries awareness client ids to
   * drop. Description cursors only — page-level cursors stay on
   * `cursor.update`.
   */
  | {
      type: "awareness.update";
      taskId: string;
      clientId?: number;
      update?: Base64Bytes;
      removed?: number[];
    }
  | {
      type: "typing.update";
      userId: UserId;
      userName?: string;
      targetId: string;
      active: boolean;
      state?: 'viewing' | 'editing';
      area?: PresenceArea | null;
    }
  | {
      type: "task.patch";
      taskId: string;
      patch: Record<string, unknown>;
      actorId: UserId;
      actorName?: string;
    }
  | { type: "task.create"; task: Record<string, unknown>; actorId: UserId }
  | { type: "task.delete"; taskId: string; actorId: UserId }
  | {
      type: "task.comment.add";
      taskId: string;
      commentId: string;
      actorId: UserId;
      actorName?: string;
    }
  /** A comment was deleted — clients drop it without a reload. */
  | {
      type: "task.comment.remove";
      taskId: string;
      commentId: string;
      actorId: UserId;
      actorName?: string;
    }
  /**
   * A comment was edited — clients apply `body` to the matching comment
   * without a reload. Shaped exactly like its `add`/`remove` siblings plus
   * the edited body (`body` matches `updateCommentSchema` and the
   * `taskComments` column, so the receiving side needs no field mapping).
   */
  | {
      type: "task.comment.update";
      taskId: string;
      commentId: string;
      body: string;
      actorId: UserId;
      actorName?: string;
    }
  | { type: "task.comment.count"; taskId: string; count: number }
  | {
      type: "task.file.add";
      taskId: string;
      fileName: string;
      /** Row id in `taskFiles` — present on new emits, absent on old ones. */
      fileId?: string;
      actorId: UserId;
      actorName?: string;
    }
  /** A file was deleted — clients drop it without a reload. */
  | {
      type: "task.file.remove";
      taskId: string;
      fileId: string;
      fileName?: string;
      actorId: UserId;
      actorName?: string;
    }
  /**
   * A task link was added/removed. Links are persisted through the generic
   * `task.patch` write (which still broadcasts), so these discrete events
   * are a live mirror for the relations surface — same end state, applied
   * idempotently on receipt.
   */
  | {
      type: "task.relation.add";
      taskId: string;
      link: { taskId: string; type: string };
      actorId: UserId;
      actorName?: string;
    }
  | {
      type: "task.relation.remove";
      taskId: string;
      link: { taskId: string; type: string };
      actorId: UserId;
      actorName?: string;
    }
  | { type: "health.ping"; redisOk?: boolean }
  | { type: "error"; message: string }
  | { type: "agent-run-started"; taskId: string; model?: string; agent?: string; command?: string; actorId: UserId }
  | { type: "agent-run-log"; taskId: string; log: string }
  | { type: "agent-run-finished"; taskId: string; exitCode: number | null; success: boolean; actorId: UserId; inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number; cost?: number };

export interface RedisEnvelope {
  roomKey: RoomKey;
  event: ServerEvent;
  sourceId: string;
}
