import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { TaskSnapshot } from "./watch-events.js";

export const STATE_FILENAME = ".vibeflow/watch-state.json";

export interface WatchState {
  /** Append-only journal of all events. Capped by age (1 minute). */
  journal: WatchStateEvent[];
  /** Per-consumer read cursors (keyed by consumer name). */
  cursors: Record<string, string>; // consumer -> ISO timestamp
  /** Previous snapshot per task (for --once diff mode). */
  previousSnapshots: Record<string, TaskSnapshot>;
  /** Version for future migrations. */
  version: number;
}

export interface WatchStateEvent {
  taskId: string;
  snapshot: TaskSnapshot;
  /** ISO timestamp when this event was recorded. */
  recordedAt: string;
}

const STATE_VERSION = 1;

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + ".tmp." + randomBytes(8).toString("hex");
  writeFileSync(tmp, data, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    // rename failed — try direct write as fallback
    writeFileSync(filePath, data, "utf8");
  }
}

export function readWatchState(projectDir: string): WatchState {
  const path = join(projectDir, STATE_FILENAME);
  if (!existsSync(path)) {
    return {
      journal: [],
      cursors: {},
      previousSnapshots: {},
      version: STATE_VERSION,
    };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as WatchState;
    // Ensure all fields exist
    return {
      version: parsed.version ?? STATE_VERSION,
      journal: Array.isArray(parsed.journal) ? parsed.journal : [],
      cursors: parsed.cursors ?? {},
      previousSnapshots: parsed.previousSnapshots ?? {},
    };
  } catch {
    // Corrupted state — reset gracefully
    return {
      journal: [],
      cursors: {},
      previousSnapshots: {},
      version: STATE_VERSION,
    };
  }
}

export function writeWatchState(projectDir: string, state: WatchState): void {
  const path = join(projectDir, STATE_FILENAME);
  // Ensure directory exists
  mkdirSync(dirname(path), { recursive: true });
  const data = JSON.stringify(state, null, 2);
  atomicWrite(path, data);
}

/**
 * Append events to the journal, capped at 1 minute old.
 */
export function appendToJournal(
  projectDir: string,
  events: WatchStateEvent[],
): void {
  const state = readWatchState(projectDir);
  const cutoff = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
  // Cap journal: remove events older than 1 minute
  state.journal = [
    ...state.journal.filter((e) => e.recordedAt > cutoff),
    ...events,
  ];
  writeWatchState(projectDir, state);
}

/**
 * Get events for a consumer since their last cursor.
 * Advances the cursor to now.
 * @param tsField - which timestamp field to filter by: 'recordedAt' (default) or 'takenAt'.
 *                 Use 'takenAt' when journal entries have stable snapshot timestamps
 *                 and you want to compare against a cursor that may have been set
 *                 during the same invocation (avoids the "same-run cursor" bug).
 */
export function getEventsForConsumer(
  projectDir: string,
  consumer: string,
  tsField: "recordedAt" | "takenAt" = "recordedAt",
  /**
   * Optional timestamp to use as "now". When provided, must be the same timestamp
   * passed to buildAllSnapshots so that entries appended with recordedAt=now
   * pass the filter (ts <= now) on the same poll cycle.
   */
  now?: string,
): { events: WatchStateEvent[]; missed: number } {
  const state = readWatchState(projectDir);
  const cursor = state.cursors[consumer] ?? "1970-01-01T00:00:00.000Z";
  const tsNow = now ?? new Date().toISOString();

  const newEvents = state.journal.filter((e) => {
    const ts = tsField === "takenAt" ? e.snapshot?.takenAt : e.recordedAt;
    return ts !== undefined && ts > cursor && ts <= tsNow;
  });

  // Count missed events (older than 1 minute from now)
  const cutoff = new Date(Date.now() - 60 * 1000).toISOString();
  const missed = state.journal.filter((e) => {
    const ts = tsField === "takenAt" ? e.snapshot?.takenAt : e.recordedAt;
    return ts !== undefined && ts > cursor && ts <= cutoff;
  }).length;

  // Advance cursor
  state.cursors[consumer] = tsNow;
  writeWatchState(projectDir, state);

  return { events: newEvents, missed };
}

/**
 * Advance a consumer's cursor without emitting events (used for --once gap handling).
 */
export function advanceCursor(projectDir: string, consumer: string): void {
  const state = readWatchState(projectDir);
  state.cursors[consumer] = new Date().toISOString();
  writeWatchState(projectDir, state);
}
