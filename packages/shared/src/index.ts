// Collab types
export type {
  UserId,
  WorkspaceId,
  RoomKey,
  UserPresence,
  PresenceArea,
  ClientEvent,
  ServerEvent,
  RedisEnvelope,
  Base64Bytes,
  DocJoinRequest,
  DocSyncMessage,
  DocUpdateMessage,
  DocAwarenessMessage,
  DocLeaveMessage,
  DocClientMessage,
} from "./collab-types";
// Value export (not `export type`): the ws server emits this subtype.
export { BOARD_REVISION_EVENT_TYPE } from "./collab-types";

// Schemas
export {
  taskStatusValues,
  createWorkspaceSchema,
  createProjectSchema,
  createBoardSchema,
  createTaskSchema,
  updateTaskSchema,
  deleteTaskSchema,
  listTasksSchema,
  createCommentSchema,
  updateCommentSchema,
  deleteCommentSchema,
  listCommentsSchema,
  deviceInitResponseSchema,
  devicePollRequestSchema,
  devicePollResponseSchema,
} from "./schemas";
export type { SaasTaskStatus } from "./schemas";

// Utils
export {
  generateId,
  userColor,
  buildRoomKey,
  parseRoomKey,
  slugify,
} from "./utils";

// Signed webhooks (scheme documented in ./webhooks)
export {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_DEFAULT_MAX_AGE_SEC,
  WEBHOOK_MAX_FUTURE_SKEW_SEC,
  signWebhookBody,
  verifyWebhookSignature,
} from "./webhooks";
export type { SignedWebhook, VerifyWebhookOptions } from "./webhooks";
