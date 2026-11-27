/**
 * `vibeflow setup <agent>` — the ONE registry of agent integrations.
 *
 * Each target owns three answers: how to DETECT that the agent is in use, how
 * to INSTALL the integration (or say honestly that there is none yet), and
 * what is currently on disk (installed? stale?). The CLI command renders these
 * answers; it never learns a path or a file name of its own, so adding an
 * agent means adding one entry here and nothing else.
 *
 * `planned` targets never write. They answer `ok: true, wrote: false` with a
 * message that points at the integration that works today for ANY agent: the
 * `vibeflow notifications --follow --exec '<cmd>'` pipe (C2). A half-built
 * installer that writes something only to look finished is worse than none.
 *
 * Decision: parent ticket 4e4feca1 (agent integration surface), sub-ticket
 * C4 6b437690.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CLI_VERSION } from "../../version.js";

export interface SetupResult {
  ok: boolean;
  target: string;
  path?: string;
  wrote: boolean;
  message: string;
}

export interface AgentTarget {
  id: "pi" | "claude" | "codex";
  title: string;
  support: "ready" | "planned";
  detect(home: string): { present: boolean; evidence: string };
  install(o: {
    home: string;
    projectDir: string;
    project: boolean;
    force: boolean;
    dryRun: boolean;
    version: string;
  }): SetupResult;
  status(o: { home: string; projectDir: string; project: boolean }): {
    installed: boolean;
    version?: string;
    drift?: boolean;
    path?: string;
  };
}

/** The pi extension file `vibeflow setup pi` owns — global and project scope. */
export const PI_EXTENSION_FILE = "vibeflow-notifications.js";

/** First line of every file this module writes: `// vibeflow-cli: <version>`. */
const STAMP_PATTERN = /^\/\/ vibeflow-cli: (.+)$/;

/**
 * Where the pi extension lives for a scope: pi's documented auto-discovery
 * locations (`~/.pi/agent/extensions/` global, `.pi/extensions/` project).
 */
export function piExtensionPath(o: {
  home: string;
  projectDir: string;
  project: boolean;
}): string {
  return o.project
    ? join(o.projectDir, ".pi", "extensions", PI_EXTENSION_FILE)
    : join(o.home, ".pi", "agent", "extensions", PI_EXTENSION_FILE);
}

/**
 * The installed version stamp, or undefined when the file is missing, has no
 * stamp, or cannot be read. Never throws: a status probe must answer even when
 * the file is unreadable (the caller reports that as drift, not as a crash).
 */
function readStampedVersion(path: string): string | undefined {
  try {
    const firstLine = readFileSync(path, "utf-8").split("\n", 1)[0] ?? "";
    return STAMP_PATTERN.exec(firstLine.trim())?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** The first set, non-blank env var with this prefix — proof an agent is running. */
function firstEnvWithPrefix(prefix: string): string | undefined {
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith(prefix)) continue;
    const value = process.env[key];
    if (value === undefined || value.trim() === "") continue;
    return key;
  }
  return undefined;
}

/**
 * Detection shared by every target: an agent-specific env var, or a config
 * directory the agent creates for itself. The evidence string names exactly
 * which one matched, so "not detected" is never a mystery.
 */
function detectAgent(o: {
  envPrefix: string;
  dirs: string[];
}): { present: boolean; evidence: string } {
  const key = firstEnvWithPrefix(o.envPrefix);
  if (key !== undefined) return { present: true, evidence: `env ${key}` };
  for (const dir of o.dirs) {
    if (existsSync(dir)) return { present: true, evidence: `dir ${dir}` };
  }
  return {
    present: false,
    evidence: `no ${o.envPrefix}* env var and no ${o.dirs.join(" / ")}`,
  };
}

/**
 * The message every `planned` target returns. One spelling: whatever the agent
 * is, the pipe that works today is the same CLI command.
 */
export function plannedMessage(title: string): string {
  return (
    `${title} is not supported yet (planned) — the generic pipe works today: ` +
    "vibeflow notifications --follow --exec '<cmd>'"
  );
}

const piTarget: AgentTarget = {
  id: "pi",
  title: "pi",
  support: "ready",
  detect(home) {
    return detectAgent({
      envPrefix: "PI_",
      dirs: [join(home, ".pi", "agent")],
    });
  },
  install(o) {
    const path = piExtensionPath(o);
    if (!o.force && existsSync(path)) {
      const installed = readStampedVersion(path);
      return {
        ok: true,
        target: "pi",
        path,
        wrote: false,
        message:
          `already installed${installed ? ` (${installed})` : ""} at ${path} — ` +
          "pass --force to overwrite",
      };
    }
    if (o.dryRun) {
      return {
        ok: true,
        target: "pi",
        path,
        wrote: false,
        message: `dry run: would write ${path}`,
      };
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, renderPiExtension(o.version, defaultCliEntry(), o.projectDir), "utf-8");
    } catch (error) {
      return {
        ok: false,
        target: "pi",
        path,
        wrote: false,
        message: `could not write ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return {
      ok: true,
      target: "pi",
      path,
      wrote: true,
      message: `installed pi extension ${o.version} at ${path}`,
    };
  },
  status(o) {
    const path = piExtensionPath(o);
    if (!existsSync(path)) return { installed: false, path };
    const installed = readStampedVersion(path);
    return {
      installed: true,
      ...(installed !== undefined ? { version: installed } : {}),
      // No readable stamp is drift: the file cannot prove it matches this CLI.
      drift: installed !== CLI_VERSION,
      path,
    };
  },
};

const claudeTarget: AgentTarget = {
  id: "claude",
  title: "claude",
  support: "planned",
  detect(home) {
    return detectAgent({
      envPrefix: "CLAUDE_",
      dirs: [join(home, ".claude")],
    });
  },
  install() {
    return {
      ok: true,
      target: "claude",
      wrote: false,
      message: plannedMessage("claude"),
    };
  },
  status() {
    return { installed: false };
  },
};

const codexTarget: AgentTarget = {
  id: "codex",
  title: "codex",
  support: "planned",
  detect(home) {
    return detectAgent({ envPrefix: "CODEX_", dirs: [join(home, ".codex")] });
  },
  install() {
    return {
      ok: true,
      target: "codex",
      wrote: false,
      message: plannedMessage("codex"),
    };
  },
  status() {
    return { installed: false };
  },
};

/** Every target, in the order `vibeflow setup` lists them. */
export function getTargets(): AgentTarget[] {
  return [piTarget, claudeTarget, codexTarget];
}

/** One target by id; undefined for an unknown id (the command reports usage). */
export function findTarget(id: string): AgentTarget | undefined {
  return getTargets().find((t) => t.id === id);
}

/**
 * The CLI entry embedded in the extension: the script this process is running
 * (`vibeflow` from an install, `dist/index.js` from a checkout) when it is a
 * real file. Null tells the extension to resolve `vibeflow` on PATH instead.
 */
function defaultCliEntry(): string | null {
  const argv1 = process.argv[1];
  if (!argv1) return null;
  try {
    const abs = resolve(argv1);
    return existsSync(abs) && /\.[cm]?js$/.test(abs) ? abs : null;
  } catch {
    return null;
  }
}

/**
 * The pi extension this CLI installs — ONE self-contained ES module with no
 * imports beyond Node builtins, so it keeps working after the CLI package is
 * upgraded, moved, or removed (the only link back is the `CLI_ENTRY` path, and
 * a missing one degrades to `vibeflow` on PATH).
 *
 * API it targets (`@earendil-works/pi-coding-agent` docs/extensions.md):
 * - `export default function (pi: ExtensionAPI)` — the documented factory form;
 * - `pi.on("session_start" | "session_shutdown")` — docs require background
 *   processes to start in `session_start`, never from the factory, and to be
 *   closed by an idempotent `session_shutdown` handler;
 * - `pi.sendMessage({customType, content, display}, {triggerTurn})`;
 * - `pi.registerCommand(name, {description, handler})` + `ctx.ui.notify`.
 *
 * The child is pinned with `--since <start iso>`: `--follow` replays its newest
 * page when it starts, and a session must not re-announce old events as work.
 */
export function renderPiExtension(
  version: string,
  cliEntry: string | null = defaultCliEntry(),
  /**
   * The project the extension should FOLLOW — the directory `vibeflow setup pi`
   * was run in. Pinned because the child otherwise inherits pi's cwd, and a
   * session started in a PARENT directory (a workspace root with its own
   * `.vibeflow`) then follows that unrelated local store instead of the linked
   * board the user installed this for. `VIBEFLOW_NOTIFY_PROJECT` overrides it
   * at runtime (a missing pinned dir falls back to the current cwd).
   */
  projectDir: string | null = null,
): string {
  return `// vibeflow-cli: ${version}
// Generated by \'vibeflow setup pi\' — rerun that command to refresh it.
// Streams vibeflow task notifications into pi: one line per event, no detail —
// run \'vibeflow tasks --get <taskId>\' for that. Read-only: it never writes.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const CUSTOM_TYPE = "vibeflow-notifications";

// What the agent needs to DO with a line, in as few words as possible. It
// rides the system prompt (before_agent_start) instead of a chat message:
// standing rule, no turn burned, and it survives a long session.
const INSTRUCTIONS = [
  "Vibeflow notifications arrive as: task <id> <type> (<changed>, or the value).",
  "A task.comment is a request: read it (vibeflow tasks --get <id>) and answer ON THAT TASK with vibeflow tasks --edit <id> --comment \\"<reply>\\" — briefly, and never answer your own comments.",
  "Any other event: act only if it touches work you own.",
].join("\\n");
// Resolved when this file was installed; null means "vibeflow" on PATH.
const CLI_ENTRY = ${JSON.stringify(cliEntry)};
// The project this integration was installed for. Without it the child runs in
// whatever directory pi happens to start in, which is how a session in a
// parent folder silently followed the wrong (local, empty) store.
const INSTALL_PROJECT = ${JSON.stringify(projectDir)};
// NO --local: the CLI already resolves the backend per project (online
// when the project is linked, local otherwise), and forcing --local made
// the extension read an empty \'.vibeflow/notifications.jsonl\' in every
// ONLINE project — connected, silent, useless. Let the same resolver the
// terminal uses pick the feed.
const CLI_ARGS = ["notifications", "--follow", "--json"];

// Keys a write always stamps, so they never answer "what happened": a status
// move arrives as (updatedAt,status,assigneeId,assigneeOrigin,verified) and the
// one word a reader needs is "status". Display-only filtering — the event
// payload stays untouched, so nothing is hidden from a consumer that reads the
// JSON itself.
const NOISE_KEYS = ["updatedAt", "sortKey", "rev", "author", "verified",
  "assigneeOrigin", "attentionReasonId", "assigneeId"];

function describeEvent(event) {
  // 'changed' names the fields a write touched; events without it (comment,
  // claim, create) carry the new values instead, so show those keys rather
  // than a bare "-" that told the reader nothing.
  const fromChanged = Array.isArray(event.changed) && event.changed.length > 0;
  const keys = fromChanged
    ? event.changed
    : event.to && typeof event.to === "object"
      ? Object.keys(event.to)
      : [];
  const meaningful = keys.filter((key) => NOISE_KEYS.indexOf(key) < 0);
  const shown = meaningful.length > 0 ? meaningful.join(",") : fromChanged ? "-" : "-";
  return "task " + event.taskId + " " + event.type + " (" + shown + ")";
}

/** The one piece of substance an event type deserves, from a fetched task. */
function detailFrom(event, task) {
  if (task === null || task === undefined) return null;
  if (event.type === "task.create" && typeof task.title === "string") {
    return { title: task.title };
  }
  if (event.type === "task.comment") {
    const comments = Array.isArray(task.comments) ? task.comments : [];
    const last = comments[comments.length - 1];
    if (last && typeof last.body === "string") return { comment: last.body };
    return null;
  }
  if (event.type === "task.file") {
    const files = Array.isArray(task.files) ? task.files : [];
    const last = files[files.length - 1];
    if (last && typeof last.name === "string") return { file: last.name };
    return null;
  }
  return null;
}

/** The line, plus the one piece of substance the event type deserves. */
function describeWith(event, detail) {
  const base = describeEvent(event);
  if (detail === null || detail === undefined) return base;
  try {
    if (event.type === "task.comment" && detail.comment) {
      return base + " · " + clip(detail.comment);
    }
    if (event.type === "task.create" && detail.title) {
      return base + ' · "' + clip(detail.title) + '"';
    }
    if (event.type === "task.file" && detail.file) {
      return base + " · " + clip(detail.file);
    }
    if (event.type === "task.update" && formalues(event)) return base + " · " + formalues(event);
  } catch {
    // A malformed detail must never suppress the line itself.
  }
  return base;
}

/** 'status: in-progress'-style summary from the event's own 'to' payload. */
function formalues(event) {
  const to = event && event.to;
  if (!to || typeof to !== "object") return null;
  const keys = Object.keys(to).filter(function (key) {
    return NOISE_KEYS.indexOf(key) < 0 && key !== "commentId";
  }).slice(0, 2);
  if (keys.length === 0) return null;
  return keys.map(function (key) { return key + ": " + clip(to[key]); }).join(", ");
}

function errorText(error) {
  if (error && typeof error.message === "string") return error.message;
  return String(error);
}

// ── substance ────────────────────────────────────────────────────────────────
// The EVENT is deliberately thin (id + what changed, never content), so the
// line names the action and nothing else. A reader then has to run a command to
// learn anything. One extra read per COMMENT or CREATE event fixes that without
// fattening the payload or the wire: the text is fetched here, on the spot.
const EXCERPT_CHARS = 70;

function clip(text) {
  const flat = String(text).replace(/\\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? flat.slice(0, EXCERPT_CHARS - 1) + "\u2026" : flat;
}

/** 'tasks --get <id> --json' in the followed project; null when unavailable. */
function readTask(taskId, onDetail) {
  const command = CLI_ENTRY === null ? "vibeflow" : process.execPath;
  const args = CLI_ENTRY === null ? ["tasks"] : [CLI_ENTRY, "tasks"];
  args.push("--get", taskId, "--json");
  const wanted = process.env.VIBEFLOW_NOTIFY_PROJECT || INSTALL_PROJECT;
  const cwd = wanted && existsSync(wanted) ? wanted : undefined;
  let out = "";
  let child;
  try {
    child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, VIBEFLOW_EVENTS: "0" },
    });
  } catch {
    onDetail(null, null);
    return;
  }
  // A slow read must not stall the feed, nor start a turn with stale text.
  const timer = setTimeout(function () {
    try {
      child.kill();
    } catch {
      // already gone
    }
    onDetail(null, null);
  }, 5000);
  if (child.stdout) child.stdout.on("data", function (chunk) { out += chunk.toString(); });
  child.on("close", function () {
    clearTimeout(timer);
    try {
      const start = out.indexOf("{");
      const task = start >= 0 ? JSON.parse(out.slice(start)).task : null;
      onDetail(task ? task.title : null, task ? task : null);
    } catch {
      onDetail(null, null);
    }
  });
}

export default function (pi) {
  // User kill switch. VIBEFLOW_NOTIFY=0 in pi's environment means "do not
  // start"; the commands below change it for the session either way, so a
  // user who finds the feed noisy can silence it without editing this file.
  let enabled = process.env.VIBEFLOW_NOTIFY !== "0";
  let child = null;
  let connected = false;
  let lastEventTs = null;
  let eventsSeen = 0;
  let failure = null;
  let failureReported = false;
  // Restart supervision (ticket qjsgsnhue): a follower that exits is restarted
  // with backoff and RESUMES from the last delivered event, so a feed that
  // drops during a long idle does not stay dropped for the rest of the session.
  let restartTimer = null;
  let restartAttempts = 0;
  let stopping = false;

  function statusLine() {
    const parts = [
      "vibeflow notifications: " + (connected ? "connected" : "disconnected"),
      "last event: " + (lastEventTs === null ? "none" : lastEventTs),
      "events seen this session: " + eventsSeen,
    ];
    if (!enabled) parts.push("switched off (/vibeflow-on to resume)");
    if (failure !== null) parts.push("problem: " + failure);
    return parts.join(" · ");
  }

  // A broken feed is not work: report it once, and never start a turn.
  function warn(message) {
    failure = message;
    if (failureReported) return;
    failureReported = true;
    try {
      pi.sendMessage(
        { customType: CUSTOM_TYPE, content: message, display: true },
        { triggerTurn: false },
      );
    } catch {
      // Reporting must never crash pi.
    }
  }

  function onLine(line) {
    const text = line.trim();
    if (text === "") return;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return; // not an event line
    }
    if (event === null || typeof event !== "object") return;
    if (typeof event.taskId !== "string" || typeof event.type !== "string") return;
    // Bookkeeping-only updates are not news: a comment lands as task.comment
    // AND as a task.update carrying just updatedAt, and a reorder carries only
    // sortKey. Filtering here (not only on the server) is deliberate — it makes
    // the feed quiet on any deployed backend version, not just the next one.
    const METADATA_ONLY = ["updatedAt", "sortKey", "rev"];
    if (event.type === "task.update") {
      const keys = Array.isArray(event.changed)
        ? event.changed
        : event.to && typeof event.to === "object"
          ? Object.keys(event.to)
          : [];
      if (keys.length > 0 && keys.every((key) => METADATA_ONLY.includes(key))) {
        return;
      }
    }
    eventsSeen += 1;
    if (typeof event.ts === "string") lastEventTs = event.ts;

    function send(detail) {
      try {
        pi.sendMessage(
          { customType: CUSTOM_TYPE, content: describeWith(event, detail), display: true },
          { triggerTurn: true },
        );
      } catch {
        // A TUI hiccup must never stop the feed.
      }
    }

    // Comment, create and file events carry no content by contract, so the
    // substance is read on the spot; everything else is fully described by the
    // event itself (an update's new values ride its own to).
    if (
      event.type === "task.comment" ||
      event.type === "task.create" ||
      event.type === "task.file"
    ) {
      readTask(event.taskId, function (_title, task) {
        send(detailFrom(event, task));
      });
      return;
    }
    send(null);
  }

  // Bounded ladder: a follower that cannot stay up must say so once and stop,
  // not spin. Reset by the first line it delivers (see the data handler).
  const RESTART_DELAYS = [1000, 2000, 5000, 15000, 30000, 60000];
  const MAX_RESTARTS = 8;

  function scheduleRestart(why) {
    if (stopping || !enabled || restartTimer !== null) return;
    if (restartAttempts >= MAX_RESTARTS) {
      warn(
        "vibeflow notifications stopped after " +
          restartAttempts +
          " restarts (" +
          why +
          ") — run 'vibeflow notifications --follow' in a terminal to see why.",
      );
      return;
    }
    const wait = RESTART_DELAYS[Math.min(restartAttempts, RESTART_DELAYS.length - 1)];
    restartAttempts += 1;
    restartTimer = setTimeout(function () {
      restartTimer = null;
      start();
    }, wait);
    if (typeof restartTimer.unref === "function") restartTimer.unref();
  }

  function start() {
    if (!enabled || child !== null) return;
    stopping = false;
    const command = CLI_ENTRY === null ? "vibeflow" : process.execPath;
    const args = CLI_ENTRY === null ? CLI_ARGS.slice() : [CLI_ENTRY].concat(CLI_ARGS);
    // The FIRST start of a session begins now (nothing older belongs to this
    // session). Every later start resumes from the last event actually
    // delivered: a follower that died must not skip what was published while it
    // was down — that is the whole bug in ticket qjsgsnhue.
    args.push(
      "--since",
      typeof lastEventTs === "string" ? lastEventTs : new Date().toISOString(),
    );
    let spawned;
    try {
      // Follow the project this was installed for, unless the operator points
      // it elsewhere; a deleted install dir must not break the extension.
      const wanted = process.env.VIBEFLOW_NOTIFY_PROJECT || INSTALL_PROJECT;
      const cwd = wanted && existsSync(wanted) ? wanted : undefined;
      spawned = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], ...(cwd ? { cwd } : {}) });
    } catch (error) {
      warn(
        "vibeflow notifications could not start (" +
          errorText(error) +
          ") — run \`vibeflow notifications --follow --json\` in a terminal to check.",
      );
      return;
    }
    child = spawned;
    connected = true;
    failure = null;
    let buffered = "";
    spawned.stdout.setEncoding("utf8");
    spawned.stdout.on("data", function (chunk) {
      // A line means the follower is healthy again: reset the ladder so a later
      // failure reports immediately instead of being muted by the latch.
      restartAttempts = 0;
      failureReported = false;
      buffered += chunk;
      const lines = buffered.split("\\n");
      buffered = lines.pop() || "";
      for (let i = 0; i < lines.length; i += 1) onLine(lines[i]);
    });
    spawned.on("error", function (error) {
      if (child === spawned) {
        child = null;
        connected = false;
      }
      warn(
        "vibeflow notifications could not start (" +
          errorText(error) +
          ") — is \`vibeflow\` on PATH?",
      );
      scheduleRestart("spawn error");
    });
    spawned.on("exit", function (code, signal) {
      if (child === spawned) {
        child = null;
        connected = false;
      }
      if (stopping) return;
      // ANY exit is news — including a clean zero. The follower exits 0 on
      // SIGHUP, on a closed stdout pipe and when its parent goes away (ticket
      // lf6egk9l), so a silent clean exit is exactly how the feed disappears
      // mid-session and nobody notices (ticket qjsgsnhue).
      const how = signal ? "signal " + signal : "exit " + code;
      warn(
        "vibeflow notifications stopped (" +
          how +
          ")" +
          (typeof lastEventTs === "string"
            ? " — restarting from the last delivered event"
            : " — restarting") +
          ".",
      );
      scheduleRestart(how);
    });
  }

  // Idempotent: session_start/session_shutdown may pair up more than once
  // (reload, /new, /resume) and the child must never be leaked.
  function stop() {
    stopping = true;
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const running = child;
    child = null;
    connected = false;
    if (running === null) return;
    try {
      running.kill();
    } catch {
      // already gone
    }
  }

  pi.registerCommand("vibeflow-off", {
    description: "Stop vibeflow task notifications for this session",
    handler: async function (_args, ctx) {
      const was = child !== null;
      enabled = false;
      stop();
      ctx.ui.notify(
        was
          ? "vibeflow notifications: off (no events until /vibeflow-on)"
          : "vibeflow notifications were already off",
        "info",
      );
    },
  });

  pi.registerCommand("vibeflow-on", {
    description: "Resume vibeflow task notifications for this session",
    handler: async function (_args, ctx) {
      enabled = true;
      start();
      ctx.ui.notify(
        child === null
          ? "vibeflow notifications: on, but the follow loop did not start — see /vibeflow-status"
          : "vibeflow notifications: on",
        child === null ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("vibeflow-status", {
    description:
      "Vibeflow notification feed: connected, last event, events this session",
    handler: async function (_args, ctx) {
      ctx.ui.notify(statusLine(), connected ? "info" : "warning");
    },
  });

  // Standing instruction (docs: before_agent_start may chain the prompt; the
  // result is diffed against what the model already has, so this costs one
  // system message patch, not a turn).
  pi.on("before_agent_start", function (event) {
    if (!enabled) return undefined;
    const base = event && typeof event.systemPrompt === "string" ? event.systemPrompt : "";
    return { systemPrompt: base + "\\n\\n" + INSTRUCTIONS };
  });

  pi.on("session_start", function () {
    start();
  });
  pi.on("session_shutdown", function () {
    stop();
  });
}
`;
}
