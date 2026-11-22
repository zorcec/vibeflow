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
import type { Task, TaskComment, TaskStatus } from "./types.js";

/**
 * Bump when the demo CONTENT changes — the marker then forces a reseed so an
 * existing ~/.vibeflow-demo picks up the new cards instead of showing a stale
 * mix of old and new.
 */
export const DEMO_SEED_VERSION = 1;

/**
 * Ids the local board may present as "the current user". The board derives its
 * id from `window.__VIBEFLOW_USER__` and falls back to `local-viewer`
 * (`client/kanban/App.tsx`), so seeding both makes the parent card open its
 * children on first sight instead of looking empty.
 */
const DEMO_VIEWER_IDS = ["local-viewer", process.env.USER ?? "", process.env.USERNAME ?? ""]
  .filter((id) => id.length > 0);

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
  /**
   * Per-user "this card's children list is open" ids. The demo seeds the
   * viewer ids it can know so the parent card opens expanded on first sight —
   * owner request 2026-11-21: "on demo kanban all children lists should be open".
   */
  expandedBy?: string[];
}

const SEED_CARDS: SeedCard[] = [
  {
    title: "Demo 1 — parent task with three sub-tasks",
    description:
      "A parent card. Its children live in different lanes so the tree is worth opening: one done, one in progress, one todo. Children open by default in the demo.",
    status: "todo",
    type: "Task",
    priority: "High",
    tags: ["demo", "parent"],
    expandedBy: DEMO_VIEWER_IDS,
    children: [
      { title: "Demo 1.1 — first sub-task (done)", status: "done" },
      { title: "Demo 1.2 — second sub-task (in progress)", status: "in-progress" },
      { title: "Demo 1.3 — third sub-task (todo)", status: "todo" },
    ],
  },
  {
    title: "Example: a bug report",
    description:
      "How an annotated bug looks. Created from the overlay on a real page, so the card carries the url and the selector it was captured from — press the card to see them.",
    status: "in-progress",
    type: "Bug",
    priority: "High",
    tags: ["example", "bug"],
    url: "https://example.com/checkout",
    selector: "#coupon-field",
    comments: [
      {
        author: "user",
        text: "Reproduced at 390px — the field slides under the summary card.",
      },
      {
        author: "agent",
        text: "Peeked at the stack: the summary card paints over the field. Fix is stacking order, not spacing.",
      },
    ],
  },
  {
    title: "Example: a research task",
    description:
      "Research tasks carry findings, options and a recommendation instead of code. This one is here to show the shape: question, options with pros and cons, then a ranked recommendation.",
    status: "backlog",
    type: "Research",
    priority: "Medium",
    tags: ["example", "research"],
  },
  {
    title: "Demo 2 — task with an attachment",
    description:
      "Cards can carry files. Open this one and look at the attachment in the detail panel.",
    status: "todo",
    type: "Task",
    priority: "Medium",
    tags: ["demo"],
    files: {
      "demo-note.md":
        "# Demo attachment\n\nThis file was seeded with the example board, so the Files tab is not empty on first run.\n",
    },
  },
  {
    title: "Demo 3 — waiting for review",
    description:
      "A card in the review lane, with a verification verdict recorded — that is the green badge.",
    status: "review",
    type: "Task",
    priority: "Medium",
    tags: ["demo"],
    verified: true,
  },
  {
    title: "Demo 4 — done, with evidence",
    description:
      "A finished card. The comment below is the kind of evidence an agent leaves before a task is closed.",
    status: "done",
    type: "Task",
    priority: "Medium",
    tags: ["demo"],
    verified: true,
    comments: [
      {
        author: "agent",
        text: "Evidence: checked the staging board, dragged the card, reloaded — the change persisted.",
      },
    ],
  },
  {
    title: "Demo 5 — low priority idea",
    description: "A backlog card with a low priority, to show how the badge differs.",
    status: "backlog",
    type: "Task",
    priority: "Low",
    tags: ["demo"],
  },
  {
    title: "Demo 6 — high priority fix",
    description: "Same shape as the others; different priority badge.",
    status: "todo",
    type: "Task",
    priority: "High",
    tags: ["demo", "fix"],
  },
  {
    title: "Demo 7 — in progress",
    description: "Something the team is on right now.",
    status: "in-progress",
    type: "Task",
    priority: "Low",
    tags: ["demo"],
  },
  {
    title: "Demo 8 — related to the bug example",
    description: "Shows a second card in review with a verdict.",
    status: "review",
    type: "Task",
    priority: "Low",
    tags: ["demo"],
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
      ...(card.expandedBy === undefined ? {} : { expandedBy: card.expandedBy }),
    } as Parameters<typeof createTask>[1]);

    const updates: Partial<Omit<Task, "id" | "created">> = {};
    if (card.verified === true) updates.verified = true;
    if (card.comments && card.comments.length > 0) {
      updates.comments = card.comments.map((c, i) => commentFor(created.id, c, i));
    }
    if (card.children && card.children.length > 0) {
      for (const child of card.children) {
        const childTask = createTask(root, {
          title: child.title,
          description: "Sub-task of: " + card.title,
          status: child.status,
          selector: "/",
          type: "Task",
        } as Parameters<typeof createTask>[1]);
        // ONE edge only, on the CHILD: `{ taskId: parent, type: "parent" }`
        // means "my parent is that task". Writing the mirror edge on the parent
        // (as this seeder first did) means "my parent is my child", which made
        // the parent its own descendant and emptied the inline children tree —
        // owner report 2026-11-21, pinned in ui/kanban/__tests__/task-links.
        updateTask(root, childTask.id, {
          links: [{ taskId: created.id, type: "parent" }],
        });
      }
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
