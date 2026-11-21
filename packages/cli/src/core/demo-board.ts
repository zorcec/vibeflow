/**
 * Local demo board (ticket ec65a901, owner order 2026-11-21).
 *
 * WHY this exists: the hosted app seeds a demo board for a fresh account
 * (ticket oe8cl6b), but `vibeflow kanban` locally shows the user's real — and
 * usually empty — store. A first-time user runs one command, sees nothing, and
 * concludes the tool does nothing. The research on 7cc00fc7 ranked a
 * zero-config `vibeflow demo` as the highest-leverage fix on the CLI surface.
 *
 * DECISION (agent, 2026-11-21): the demo store lives at a FIXED path OUTSIDE
 * any project (`~/.vibeflow-demo`, override `VIBEFLOW_DEMO_DIR`). It is
 * deliberately not a git repo and never the caller's cwd, so `vibeflow demo`
 * can be run from anywhere and can never write into a real `.vibeflow/` store.
 *
 * DECISION: seeding uses the ordinary task APIs (`createTask`, `updateTask`,
 * `saveFile`) rather than hand-written JSON. Those are the same code paths a
 * real add/edit takes, so a seeded record cannot be a shape the board fails to
 * read — and the store stays byte-identical in format to a real one.
 *
 * IDEMPOTENCY: a marker (`.vibeflow/demo-seed.json`) records the seed version.
 * Re-running `vibeflow demo` is a no-op while the marker matches, so cards are
 * never duplicated; `--reset` or a version bump wipes and reseeds.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTask, ensureTaskDirs, updateTask } from "./tasks.js";
import { saveFile } from "./files.js";
import type { Task, TaskComment, TaskLink, TaskStatus } from "./types.js";

/**
 * Bump when the demo CONTENT changes — the marker then forces a reseed so an
 * existing ~/.vibeflow-demo picks up the new cards instead of showing a stale
 * mix of old and new.
 */
export const DEMO_SEED_VERSION = 1;

const DEMO_ROOT_ENV = "VIBEFLOW_DEMO_DIR";
const MARKER_REL = join(".vibeflow", "demo-seed.json");

/** Absolute path of the demo project root (not a git repo, never the cwd). */
export function resolveDemoRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DEMO_ROOT_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  return join(homedir(), ".vibeflow-demo");
}

export interface SeedResult {
  /** False when the marker already matched and nothing was written. */
  seeded: boolean;
  /** Cards in the demo store after the call. */
  count: number;
  root: string;
}

interface SeedCard {
  title: string;
  description: string;
  status: TaskStatus;
  type?: string;
  priority?: string;
  tags?: string[];
  /** Hero card: carries a real URL + selector so annotate→task is visible. */
  url?: string;
  selector?: string;
  verified?: boolean;
  /** Sub-tasks are created first and linked as children of this card. */
  children?: Array<{ title: string; status: TaskStatus }>;
  comments?: Array<{ author: "user" | "agent"; text: string }>;
  /** name → utf8 content. Written through saveFile (same path as a real attach). */
  files?: Record<string, string>;
}

const SEED_CARDS: SeedCard[] = [
  {
    title: "Write refund policy page copy",
    description:
      "Draft the copy, then annotate the staging page so the task carries a selector.",
    status: "backlog",
    type: "Task",
    priority: "Medium",
    tags: ["content"],
  },
  {
    title: "Set up error tracking for checkout",
    description:
      "Wire the client SDK and confirm a test event lands before merge.",
    status: "backlog",
    type: "Task",
    priority: "High",
    tags: ["infra"],
  },
  {
    title: "Annotate staging checkout — coupon field overlap",
    description:
      "Created from the overlay. The coupon input collides with the order-summary card at phone widths; the selector below is what the overlay captured.",
    status: "todo",
    type: "Bug",
    priority: "High",
    tags: ["annotated", "mobile"],
    url: "https://example.com/checkout",
    selector: "#coupon-field",
    comments: [
      {
        author: "user",
        text: "Reproduced on a 390px viewport — the field slides under the summary card.",
      },
      {
        author: "agent",
        text: "Found it: `.summary-card` has `position: sticky` with no `z-index`, so it paints over the field. Fix is stacking order, not spacing.",
      },
    ],
    files: {
      "coupon-overlap.md":
        "# Coupon field overlap\n\n- viewport: 390x844\n- selector: `#coupon-field`\n- cause: sticky summary card paints over the input\n- fix: give the summary card `z-index: 1` and the field row `position: relative`\n",
    },
    children: [
      { title: "Reproduce at 360px", status: "done" },
      { title: "Fix z-index stacking", status: "in-progress" },
      { title: "Re-verify with the overlay", status: "review" },
    ],
  },
  {
    title: "Add Apple Pay button to cart",
    description:
      "Behind the payments feature flag; still needs a real device test on iOS Safari.",
    status: "todo",
    type: "Task",
    priority: "Medium",
    tags: ["payments"],
  },
  {
    title: "Fix guest-checkout email validation",
    description:
      "The accepted-TLD list is stale — switch to the shared validator.",
    status: "in-progress",
    type: "Bug",
    priority: "High",
    tags: ["bug"],
  },
  {
    title: "Localise cart strings (de/at)",
    description: "12 keys pending review from the translation team.",
    status: "in-progress",
    type: "Task",
    priority: "Low",
    tags: ["i18n"],
  },
  {
    title: "Cart: show tax-included notice for EU",
    description:
      "Verified on the staging board — waiting for a second pair of eyes before merge.",
    status: "review",
    type: "Task",
    priority: "Medium",
    tags: ["qa"],
    verified: true,
  },
  {
    title: "Speed up /cart first paint",
    description: "LCP 2.4s → 1.6s on staging after deferring the review widget.",
    status: "review",
    type: "Task",
    priority: "Medium",
    tags: ["perf"],
  },
  {
    title: "Ship checkout telemetry events",
    description:
      "checkout_started / step_completed / purchase are emitting; dashboards read them.",
    status: "done",
    type: "Task",
    priority: "Medium",
    tags: ["analytics"],
    verified: true,
    comments: [
      {
        author: "agent",
        text: "Evidence: all three events observed on staging for one full purchase; no duplicate purchase events in a 30-minute window.",
      },
    ],
  },
  {
    title: "Fix mobile keypad covering the pay button",
    description:
      "Reproduced at 360px, fixed with a visualViewport offset on focus.",
    status: "done",
    type: "Bug",
    priority: "High",
    tags: ["mobile"],
    verified: true,
  },
];

function commentFor(taskId: string, c: { author: "user" | "agent"; text: string }, ordinal: number): TaskComment {
  // Deterministic id — a reseed produces identical bytes, so `git diff`-style
  // comparisons of two seeds stay empty.
  const id = createHash("sha1").update(`${taskId}:${ordinal}:${c.author}:${c.text}`).digest("hex").slice(0, 24);
  return {
    id,
    author: c.author,
    text: c.text,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Writes the demo cards into `root` WITHOUT wiping anything. Shared by the
 * `vibeflow demo` refresh path and the first-run auto-seed (ticket e5176b6c) —
 * one copy of the sample content, one writer.
 */
function writeSeedCards(root: string): void {
  ensureTaskDirs(root);
  for (const card of SEED_CARDS) {
    const created = createTask(root, {
      title: card.title,
      description: card.description,
      status: card.status,
      selector: card.selector ?? "/",
      ...(card.type === undefined ? {} : { type: card.type }),
      ...(card.priority === undefined ? {} : { priority: card.priority }),
      ...(card.tags === undefined ? {} : { tags: card.tags }),
      ...(card.url === undefined ? {} : { url: card.url }),
    } as Parameters<typeof createTask>[1]);

    const updates: Partial<Omit<Task, "id" | "created">> = {};
    if (card.verified === true) updates.verified = true;
    if (card.comments && card.comments.length > 0) {
      updates.comments = card.comments.map((c, i) => commentFor(created.id, c, i));
    }
    if (card.children && card.children.length > 0) {
      const childLinks: TaskLink[] = [];
      for (const child of card.children) {
        const childTask = createTask(root, {
          title: child.title,
          description: "Sub-task of: " + card.title,
          status: child.status,
          selector: "/",
          type: "Task",
        } as Parameters<typeof createTask>[1]);
        updateTask(root, childTask.id, {
          links: [{ taskId: created.id, type: "parent" }],
        });
        childLinks.push({ taskId: childTask.id, type: "parent" });
      }
      updates.links = [...(updates.links ?? []), ...childLinks];
    }
    if (Object.keys(updates).length > 0) updateTask(root, created.id, updates);
    for (const [name, body] of Object.entries(card.files ?? {})) {
      saveFile(root, created.id, name, Buffer.from(body, "utf8"));
    }
  }
}

/** Counts task JSON files in a project store (0 when the store is absent). */
export function countStoredTasks(root: string): number {
  const tasksDir = join(root, ".vibeflow", "tasks");
  if (!existsSync(tasksDir)) return 0;
  let n = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".json")) n += 1;
    }
  };
  walk(tasksDir);
  return n;
}

export interface AutoSeedResult {
  seeded: boolean;
  count: number;
  /** Why nothing was seeded — only set when `seeded` is false. */
  reason?: "marker" | "not-empty";
}

/**
 * First-run auto-seed for a LOCAL project (owner order 2026-11-21, ticket
 * e5176b6c: "every new empty project has demo data by default").
 *
 * Three rules, each load-bearing:
 *  1. A project that already has ANY task is never seeded — never merge sample
 *     data into real work, never inflate counts.
 *  2. A project that was seeded once is never seeded again, even if the user
 *     deleted every sample: the MARKER decides, not emptiness, or deleted cards
 *     would resurrect on the next boot.
 *  3. Seeds go through the same `writeSeedCards` path as `vibeflow demo`, so
 *     there is exactly one copy of the sample content.
 */
export function maybeSeedEmptyProject(root: string): AutoSeedResult {
  const markerPath = join(root, MARKER_REL);
  if (existsSync(markerPath)) {
    return { seeded: false, count: countStoredTasks(root), reason: "marker" };
  }
  const existing = countStoredTasks(root);
  if (existing > 0) {
    return { seeded: false, count: existing, reason: "not-empty" };
  }

  mkdirSync(join(root, ".vibeflow"), { recursive: true });
  writeSeedCards(root);
  writeFileSync(
    markerPath,
    JSON.stringify(
      { version: DEMO_SEED_VERSION, seededAt: new Date().toISOString(), source: "first-run" },
      null,
      2,
    ) + "\n",
  );
  return { seeded: true, count: countStoredTasks(root) };
}

function wipeDemoStore(root: string): void {
  const proto = join(root, ".vibeflow");
  for (const sub of ["tasks", "files"]) {
    const p = join(proto, sub);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

/**
 * Seed (or refresh) the demo store. Idempotent: returns `seeded: false` when
 * the marker already records the current version.
 */
export function seedDemoBoard(root: string, opts: { reset?: boolean } = {}): SeedResult {
  const markerPath = join(root, MARKER_REL);
  const existingCount = (): number => {
    const tasksDir = join(root, ".vibeflow", "tasks");
    if (!existsSync(tasksDir)) return 0;
    let n = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith(".json")) n += 1;
      }
    };
    walk(tasksDir);
    return n;
  };

  if (!opts.reset && existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { version?: number };
      if (marker.version === DEMO_SEED_VERSION) {
        return { seeded: false, count: existingCount(), root };
      }
    } catch {
      // Unreadable marker → fall through and reseed. A demo store is disposable.
    }
  }

  wipeDemoStore(root);
  mkdirSync(join(root, ".vibeflow"), { recursive: true });
  writeSeedCards(root);

  writeFileSync(
    markerPath,
    JSON.stringify({ version: DEMO_SEED_VERSION, seededAt: new Date().toISOString() }, null, 2) + "\n",
  );

  return { seeded: true, count: existingCount(), root };
}
