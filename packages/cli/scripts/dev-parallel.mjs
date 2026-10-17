#!/usr/bin/env node
/**
 * Parallel dev entry: run the watching rebuild and the dev board together.
 *
 * WHAT: spawns `tsup --watch` (rebuilds dist/client/kanban-browser.js on
 * every edit) AND `vibeflow kanban --dev` (serves the on-disk bundle +
 * live-reloads the browser on rebuild) as two children of this process,
 * prefixes their output ([watch]/[board]), and tears BOTH down when either
 * exits or when this process gets SIGINT/SIGTERM — one Ctrl+C leaves no
 * orphans. Extra CLI args after `--` forward to the kanban command, e.g.
 * `pnpm vibeflow -- -p 45210` to dodge a live board on the default 3700.
 *
 * WHY: the dev loop from ticket 7e85c338 needs both halves running, and two
 * terminals is friction nobody keeps up. Bespoke ~80-line runner instead of
 * a concurrently/npm-run-all dependency: this repo already keeps its build
 * tooling as .mjs scripts, and exact kill semantics (kill the whole child,
 * not just the shell) matter more here than a dependency's feature set.
 * No gating on the first build: the dev server 500s LOUDLY (naming the
 * tsup --watch fix) until the bundle exists, so starting order is harmless.
 *
 * Ticket: a8f7033e (parallel `vibeflow` dev script).
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The board serves the INVOCATION directory (your project), not the repo.
const BOARD_DIR = process.cwd();

const [, , ...rawArgs] = process.argv;
// npm/pnpm forward everything after their own `--` verbatim, so OUR argv
// still starts with it — consume it here, or the kanban command would see a
// literal `--` (ending ITS option parsing) and treat `-p` as a board dir
// (manual find, ticket a8f7033e: "Project root not found: <cwd>/-p").
const passthrough = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

function prefixed(tag, color) {
  return (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.length > 0) process.stdout.write(`${color}[${tag}]\x1b[0m ${line}\n`);
    }
  };
}

const children = new Set();
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    // Kill the whole child; it was spawned WITHOUT a shell wrapper, so its
    // PID is the real process (no intermediate sh to orphan grandchildren).
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Give them a beat, then force what lingers and exit with the cause.
  setTimeout(() => {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    process.exit(code);
  }, 1500).unref();
}

function launch(tag, color, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.stdout.on("data", prefixed(tag, color));
  child.stderr.on("data", prefixed(tag, color));
  child.on("error", (err) => {
    process.stdout.write(`\x1b[31m[run]\x1b[0m failed to start ${tag}: ${err.message}\n`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    // Either half dying ends the session: a board without rebuilds is the
    // stale-bundle trap, and rebuilds without a board serve nobody.
    if (!shuttingDown) {
      process.stdout.write(
        `\x1b[31m[run]\x1b[0m ${tag} exited (${signal ?? `code ${code}`}) — stopping the other half.\n`,
      );
      shutdown(code ?? 1);
    }
  });
  return child;
}

// tsup resolves from packages/cli/node_modules via npx --no-install: local
// install or a loud failure, never a surprise global download.
launch("watch", "\x1b[36m", "npx", ["--no-install", "tsup", "--watch"], CLI_DIR);
launch("board", "\x1b[32m", process.execPath, [join(CLI_DIR, "dist", "cli", "index.js"), "kanban", "--dev", ...passthrough], BOARD_DIR);

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.stdout.write(
  `\x1b[32m[run]\x1b[0m watch (tsup --watch) + board (kanban --dev${passthrough.length ? ` ${passthrough.join(" ")}` : ""}) starting — Ctrl+C stops both.\n`,
);
