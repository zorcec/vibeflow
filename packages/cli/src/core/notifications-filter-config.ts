/**
 * Follower-side notification filter — `.vibeflow/notifications-filter.json`
 * plus repeatable `--filter-<dim>` flags (ticket za93ov003x6rbqv2xy9detoo,
 * mock #5c).
 *
 * The SERVER does the filtering (both backends, ticket
 * kjiodwjxmk4j90cek02amgrj); this module only decides WHICH dimensions this
 * follower asks for and how they reach the wire. Three honesty rules:
 *
 * - a broken config never becomes a silent empty feed — an unreadable file
 *   warns once and the follower follows UNFILTERED; a bad value drops THAT
 *   dimension (the rest of the file still applies) and says so;
 * - flags win per dimension over the file — an explicit CLI intent beats a
 *   stale file without editing it;
 * - serialisation repeats the param once per value and never emits a blank
 *   element: a fat-fingered blank must not become a server-side constraint
 *   (blank means "no constraint" on the wire, and emitting nothing is the
 *   same answer with less traffic).
 *
 * The config schema is STRICT: exactly the five dimensions below, arrays of
 * 1–128-char control-char-free tokens (the shared
 * {@link isValidNotificationFilterValue}). An unknown key — including any
 * dimension the two cores do not both implement — is warned and ignored.
 * Zero matches is NOT an error: a filter that hides everything is a filter
 * working as asked, and the preview line says so.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isValidNotificationFilterValue,
  NOTIFICATION_FILTER_DIMENSIONS,
  type NotificationFilter,
} from "./notifications.js";
import { PROTO_DIR } from "./types.js";

/** File name under `<project>/.vibeflow/`. */
export const NOTIFICATIONS_FILTER_FILENAME = "notifications-filter.json";

/**
 * The strict config/flag schema — the ticket's five dimensions, in the order
 * the preview line describes them. `agent` is deliberately NOT here: the
 * follower's own self-suppression already keys on `agent`, and a file-level
 * `agent` constraint would silently interact with it. Unknown keys warn.
 */
export const NOTIFICATIONS_FILTER_CONFIG_DIMENSIONS = [
  "taskType",
  "type",
  "actor",
  "status",
  "taskId",
] as const;

export type NotificationFilterConfigDimension =
  (typeof NOTIFICATIONS_FILTER_CONFIG_DIMENSIONS)[number];

/** Dimension → OR-list of valid tokens. An absent key imposes nothing. */
export type NotificationsFilterMap = Partial<
  Record<NotificationFilterConfigDimension, string[]>
>;

export interface LoadedNotificationsFilter {
  /** Ready to serialise; empty object = follow unfiltered. */
  filter: NotificationsFilterMap;
  /** One line per problem — the caller prints each exactly once, to stderr. */
  warnings: string[];
}

function isConfigDimension(key: string): key is NotificationFilterConfigDimension {
  return (
    NOTIFICATIONS_FILTER_CONFIG_DIMENSIONS as readonly string[]
  ).includes(key);
}

/** Describe an invalid element without ever echoing its raw bytes (control chars). */
function invalidReason(element: unknown): string {
  if (typeof element !== "string") return "a non-string value";
  if (element.length === 0) return "an empty value";
  if (element.length > 128) return `${element.length} characters (max 128)`;
  return "control characters";
}

/**
 * Read and validate the config file. Missing file ⇒ `{}` with no warning
 * (a project without one is the default). ANY other failure — unreadable,
 * unparseable, not an object — warns once and returns `{}`: follow
 * unfiltered, never a crash, never a silently empty feed.
 */
function readConfigFile(projectDir: string): {
  dims: NotificationsFilterMap;
  warnings: string[];
} {
  const path = join(projectDir, PROTO_DIR, NOTIFICATIONS_FILTER_FILENAME);
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warnings.push(
        `${NOTIFICATIONS_FILTER_FILENAME} is unreadable (${code ?? "I/O error"}) — following unfiltered.`,
      );
    }
    return { dims: {}, warnings };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(
      `${NOTIFICATIONS_FILTER_FILENAME} is not valid JSON — following unfiltered.`,
    );
    return { dims: {}, warnings };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(
      `${NOTIFICATIONS_FILTER_FILENAME} must be a JSON object of dimension → values — following unfiltered.`,
    );
    return { dims: {}, warnings };
  }
  const dims: NotificationsFilterMap = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!isConfigDimension(key)) {
      warnings.push(
        `${NOTIFICATIONS_FILTER_FILENAME}: unknown dimension \`${key}\` ignored (known: ${NOTIFICATIONS_FILTER_CONFIG_DIMENSIONS.join(", ")}) — the rest of the file still applies.`,
      );
      continue;
    }
    if (!Array.isArray(value)) {
      warnings.push(
        `${NOTIFICATIONS_FILTER_FILENAME}: \`${key}\` must be an array of values — dropping that dimension (the rest still applies).`,
      );
      continue;
    }
    const values: string[] = [];
    let bad: string | null = null;
    for (const element of value) {
      if (
        typeof element !== "string" ||
        !isValidNotificationFilterValue(element)
      ) {
        bad = invalidReason(element);
        break;
      }
      values.push(element);
    }
    if (bad !== null) {
      warnings.push(
        `${NOTIFICATIONS_FILTER_FILENAME}: \`${key}\` has an invalid value (${bad}) — dropping that dimension (the rest still applies).`,
      );
      continue;
    }
    // An empty array is valid and imposes nothing — the same as the key
    // being absent, so it simply never reaches the filter.
    if (values.length > 0) dims[key] = values;
  }
  return { dims, warnings };
}

/**
 * Resolve the filter this follower runs with: file (unless bypassed) merged
 * with flags, flags winning per dimension. Values are re-validated here even
 * when they came from flags — an invalid flag value warns and drops THAT
 * dimension rather than being sent to the board for a 400.
 */
export function loadNotificationsFilter(
  projectDir: string,
  opts: { bypassFile?: boolean; flags?: NotificationsFilterMap } = {},
): LoadedNotificationsFilter {
  const warnings: string[] = [];
  const fileDims = opts.bypassFile === true
    ? { dims: {}, warnings }
    : readConfigFile(projectDir);
  warnings.push(...fileDims.warnings);
  const filter: NotificationsFilterMap = {};
  for (const dimension of NOTIFICATIONS_FILTER_CONFIG_DIMENSIONS) {
    const flagValues = opts.flags?.[dimension];
    const chosen = flagValues === undefined ? fileDims.dims[dimension] : flagValues;
    if (chosen === undefined) continue;
    if (flagValues !== undefined) {
      // Flags bypass the file's validation path, so validate them here with
      // the SAME rule — one bad flag value drops that dimension, with a
      // warning that names the flag, not the file.
      const values: string[] = [];
      let bad: string | null = null;
      for (const element of flagValues) {
        if (
          typeof element !== "string" ||
          !isValidNotificationFilterValue(element)
        ) {
          bad = invalidReason(element);
          break;
        }
        values.push(element);
      }
      if (bad !== null) {
        warnings.push(
          `--filter-${dimension} has an invalid value (${bad}) — dropping that dimension.`,
        );
        continue;
      }
      if (values.length > 0) filter[dimension] = values;
      continue;
    }
    filter[dimension] = chosen;
  }
  return { filter, warnings };
}

/**
 * Serialise the filter onto a feed URL: ONE `append` per value per dimension,
 * so `actor: ["a","b"]` becomes `actor=a&actor=b` (OR on the wire). A blank
 * element is skipped and a dimension with nothing left emits no param at all
 * — the wire's "blank = no constraint" rule means never sending it is both
 * the same semantics and fewer bytes.
 */
export function appendNotificationsFilterParams(
  url: URL,
  filter: NotificationFilter | undefined,
): void {
  if (filter === undefined) return;
  for (const dimension of NOTIFICATION_FILTER_DIMENSIONS) {
    const raw = filter[dimension];
    if (raw === undefined) continue;
    const values = typeof raw === "string" ? [raw] : raw;
    for (const value of values) {
      if (value.trim() === "") continue;
      url.searchParams.append(dimension, value);
    }
  }
}

/**
 * The honest preview line (ticket za93ov003x6rbqv2xy9detoo):
 * `filters: <dim=v, dim=v|v> · N events in window, M delivered, K filtered`.
 *
 * `N = count + filteredCount` is the since-window this read accounted for,
 * `M = count` is the page the server handed back, `K = filteredCount` is the
 * server's own drop count (the follower NEVER filters after the fact, so K is
 * the server's truth, not a client tally). `|` joins OR-values within a
 * dimension; `, ` separates dimensions.
 */
export function renderNotificationsFilterPreview(
  filter: NotificationFilter,
  answer: { count: number; filteredCount: number },
): string {
  const described = NOTIFICATIONS_FILTER_CONFIG_DIMENSIONS.filter(
    (dimension) => {
      const raw = filter[dimension];
      if (raw === undefined) return false;
      const values = typeof raw === "string" ? [raw] : raw;
      return values.some((value) => value.trim() !== "");
    },
  )
    .map((dimension) => {
      const raw = filter[dimension]!;
      const values = (typeof raw === "string" ? [raw] : raw).filter(
        (value) => value.trim() !== "",
      );
      return `${dimension}=${values.join("|")}`;
    })
    .join(", ");
  const windowSize = answer.count + answer.filteredCount;
  return `filters: ${described} · ${windowSize} events in window, ${answer.count} delivered, ${answer.filteredCount} filtered`;
}
