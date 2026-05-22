export type UserId = string;
export type WorkspaceId = string;
export type RoomKey = string; // workspace:{id}:project:{id}:board:{id}

export interface UserPresence {
  userId: UserId;
  name: string;
  color: string; // deterministic HSL hash of userId
  currentPath: string;
}

export type ClientEvent =
  | { type: "presence.join"; roomKey: RoomKey; user: UserPresence }
  | { type: "presence.update"; roomKey: RoomKey; patch: Partial<UserPresence> }
  | { type: "presence.leave"; roomKey: RoomKey }
  | { type: "cursor.update"; roomKey: RoomKey; x: number; y: number }
  | {
      type: "typing.update";
      roomKey: RoomKey;
      targetId: string;
      active: boolean;
      state?: 'viewing' | 'locked';
    }
  | { type: "task.subscribe"; workspaceId: string }
  | { type: "task.unsubscribe"; workspaceId: string };

export type ServerEvent =
  | { type: "presence.join"; user: UserPresence }
  | { type: "presence.update"; userId: UserId; patch: Partial<UserPresence> }
  | { type: "presence.leave"; userId: UserId }
  | { type: "cursor.update"; userId: UserId; x: number; y: number }
  | {
      type: "typing.update";
      userId: UserId;
      userName?: string;
      targetId: string;
      active: boolean;
      state?: 'viewing' | 'locked';
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
  | { type: "task.comment.count"; taskId: string; count: number }
  | {
      type: "task.file.add";
      taskId: string;
      fileName: string;
      actorId: UserId;
      actorName?: string;
    }
  | { type: "health.ping"; redisOk?: boolean }
  | { type: "error"; message: string };

export interface RedisEnvelope {
  roomKey: RoomKey;
  event: ServerEvent;
  sourceId: string;
}
