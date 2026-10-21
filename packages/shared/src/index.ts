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
  TASK_DESCRIPTION_MAX,
  formatDescriptionTooLong,
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

// Compression policy (single source of truth for CLI uploads + server
// at-rest storage — both sides implement their thin wrappers on top).
export {
  BROTLI_ENCODING,
  BROTLI_QUALITY,
  COMPRESSIBLE_EXTENSIONS,
  isCompressibleTextArtifact,
  shouldStoreCompressed,
} from "./compression";

// Push-delta hashing (canonical JSON + sha256) lives in the `./delta-hash`
// SUBPATH and is deliberately NOT re-exported from this barrel. It imports
// `node:crypto`, so a re-export here makes every consumer of this index pull
// it in — including the CLI's browser-target overlay bundle, whose esbuild
// pass fails outright with `Could not resolve "node:crypto"`. Import it as
// `@vibeflow-tools/shared/delta-hash`.
// The canonical TaskRecord schema below is node-free (zod only) and IS safe
// to re-export from this barrel. Hashing still lives in `./delta-hash`; mix
// the two only in Node runtimes:
//   import { parseTaskRecord } from "@vibeflow-tools/shared";
//   import { hashTaskRecord } from "@vibeflow-tools/shared/delta-hash";
export {
  TASK_RECORD_SCHEMA_VERSION,
  TASK_RECORD_DESCRIPTION_MAX,
  PERSISTED_COMMENT_TEXT_MAX,
  TASK_RECORD_STATUSES,
  TASK_RECORD_COMMENT_AUTHORS,
  TASK_RECORD_COMMENT_TYPES,
  TASK_RECORD_SOURCES,
  TASK_RECORD_LINK_TYPES,
  ISO_8601_UTC_RE,
  isRecordAuthorEmail,
  TaskLinkRecordSchema,
  TaskCommitRecordSchema,
  TaskCommentRecordSchema,
  TaskFileRecordSchema,
  TaskRecordSchema,
  parseTaskRecord,
  validateRecordDomain,
  toCanonicalBytes,
} from "./task-record";
export type {
  TaskRecordStatus,
  TaskLinkRecord,
  TaskCommitRecord,
  TaskCommentRecord,
  TaskFileRecord,
  TaskRecord,
  RecordIssue,
} from "./task-record";

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
