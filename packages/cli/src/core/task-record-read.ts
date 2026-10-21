import { createHash } from "node:crypto";
import {
  parseTaskRecord,
  ISO_8601_UTC_RE,
  type RecordIssue,
  type TaskRecord,
} from "@vibeflow-tools/shared/task-record";

export interface TaskRecordFinding {
  rule: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface LocalTaskRecordRead {
  /** Only the repaired input can become a display/merge/push candidate. */
  record: Record<string, unknown> | null;
  canonical: TaskRecord | null;
  findings: TaskRecordFinding[];
  issues: RecordIssue[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Version-0 compatibility view, not a migration. Wave 2 deliberately validates
 * a stamped COPY: adding versions to clean local records would re-upload the
 * entire board. Stage 2.5 owns strict writers; only explicit repairs persist.
 */
export function taskRecordValidationView(raw: Record<string, unknown>): Record<string, unknown> {
  const view = structuredClone(raw);
  if (!("schemaVersion" in view)) view.schemaVersion = 1;
  for (const key of ["comments", "files"]) {
    if (Array.isArray(view[key])) {
      for (const child of view[key]) {
        if (isObject(child) && !("schemaVersion" in child)) child.schemaVersion = 1;
      }
    }
  }
  return view;
}

// Closed, optional scalar set. Unknown keys/values are NEVER deleted to make
// strict parsing pass: those records remain quarantined for an explicit decision.
// Open comment author labels and empty commit SHAs are valid data, not repairs;
// the shared schema preserves them verbatim without coercion or deletion.
const OPTIONAL_SCALARS = new Set([
  "description", "type", "priority", "selector", "cssSelector", "file", "url",
  "line", "col", "component", "author", "agent", "model", "branchName",
  "reportBack", "verified", "authorEmail", "annotatedElementText", "sortKey",
  "updated", "commit", "screenshot", "baselineElementFile", "baselineFile",
]);

/** Read repair is pure, named and loss-limited; quarantine is not a TaskRecord. */
export function inspectLocalTaskRecord(input: unknown): LocalTaskRecordRead {
  if (!isObject(input)) {
    return { record: null, canonical: null, findings: [], issues: [{ path: "", code: "invalid_record", message: "Expected a task object" }] };
  }
  const record = structuredClone(input);
  const findings: TaskRecordFinding[] = [];
  const change = (obj: Record<string, unknown>, key: string, field: string, rule: string, after: unknown): void => {
    findings.push({ rule, field, before: obj[key], after: after === undefined ? "absent" : after });
    if (after === undefined) delete obj[key];
    else obj[key] = after;
  };

  // A future-version record must not be repaired by an older reader.
  if (!("schemaVersion" in record) || record.schemaVersion === 1) {
    if (!("status" in record)) change(record, "status", "status", "status-to-todo", "todo");
    if ("type" in record && (typeof record.type !== "string" || !record.type.trim() || /^\[object .+\]$/.test(record.type.trim()))) {
      change(record, "type", "type", "drop-invalid-type", undefined);
    }
    for (const key of OPTIONAL_SCALARS) {
      if (record[key] === null) change(record, key, key, "drop-null-scalars", undefined);
    }
    if ("links" in record) {
      const links = record.links;
      const valid = Array.isArray(links) ? links.filter((link: unknown) => isObject(link) && typeof link.taskId === "string" && link.taskId.length > 0 && ["parent", "relates", "blocks"].includes(String(link.type))) : [];
      if (valid.length === 0) change(record, "links", "links", "drop-empty-links", undefined);
      else if (Array.isArray(links) && valid.length !== links.length) change(record, "links", "links", "filter-links", valid);
    }
    if (Array.isArray(record.comments)) {
      const comments = record.comments;
      comments.forEach((comment: unknown, index: number) => {
        if (!isObject(comment) || ("schemaVersion" in comment && comment.schemaVersion !== 1)) return;
        const prefix = `comments[${index}]`;
        for (const [alias, key] of [["content", "text"], ["body", "text"], ["role", "author"], ["created", "createdAt"], ["at", "createdAt"]]) {
          if (!(alias in comment)) continue;
          const value = comment[alias];
          const usable = typeof value === "string" && (key === "author" ? ["user", "agent"].includes(value) : key === "createdAt" ? ISO_8601_UTC_RE.test(value) : value.length > 0);
          if (!usable || (key in comment && comment[key] !== value)) continue;
          if (!(key in comment)) change(comment, key, `${prefix}.${key}`, `alias-${alias}`, value);
          change(comment, alias, `${prefix}.${alias}`, `alias-${alias}`, undefined);
        }
        if (!("createdAt" in comment) && typeof record.created === "string" && ISO_8601_UTC_RE.test(record.created)) {
          change(comment, "createdAt", `${prefix}.createdAt`, "missing-comment-timestamp", record.created);
        }
        if (!("id" in comment) && typeof record.id === "string" && typeof comment.author === "string" && typeof comment.text === "string") {
          const digest = createHash("sha256").update(`${record.id}\u0000${index}\u0000${comment.author}\u0000${comment.text}`).digest("hex");
          const id = `c${digest.slice(0, 24)}`;
          if (!comments.some((other: unknown) => isObject(other) && other.id === id)) {
            change(comment, "id", `${prefix}.id`, "mint-comment-id", id);
          }
        }
      });
    }
  }
  const parsed = parseTaskRecord(taskRecordValidationView(record));
  return parsed.ok
    ? { record, canonical: parsed.record, findings, issues: [] }
    : { record: null, canonical: null, findings, issues: parsed.issues };
}

export interface TaskStoreNotice { code: string; message: string }
export interface TaskReadFinding { id: string; quarantined: boolean; findings: TaskRecordFinding[]; issues: RecordIssue[] }

export function taskReadNotices(reads: TaskReadFinding[]): TaskStoreNotice[] {
  return [false, true].flatMap((quarantined) => {
    const ids = [...new Set(reads.filter((read) => read.quarantined === quarantined && (quarantined || read.findings.length > 0)).map((read) => read.id))].sort();
    return ids.length === 0 ? [] : [{
      code: quarantined ? "TASK_RECORD_QUARANTINED" : "TASK_RECORD_REPAIRED",
      message: `${ids.length} task record(s) ${quarantined ? "quarantined (excluded from listing/merge/push)" : "repaired in memory (disk unchanged)"}: ${ids.join(", ")}.${quarantined ? ` Not auto-repairable: ${ids.map((id) => `${id}: ${reads.find((read) => read.id === id && read.quarantined)?.issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ")}`).join(" | ")}.` : ""} Run tasks --normalize for repair details.`,
    }];
  });
}
