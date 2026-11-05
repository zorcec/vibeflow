// Example after-hook: nudge the agent when a task moves to review.
//
// Copy VERBATIM to `.vibeflow-hooks/tasks.after.mjs`.
// Removal restores the shipped default for `tasks` (ADR-0007:
// project beats global beats shipped, first hit wins, REPLACE never merge).
//
// What it does: when the confirmed update left the task in `review`, it
// returns one `instructions` string reminding the agent to attest the review
// verdict. Any other update returns `{}` (no-op). Pure and offline: no
// network, no config file, no secrets — and NEVER any Vibeflow token.
//
// Why it reads the envelope first: the AFTER envelope carries the
// confirmed snapshot in `task` (see docs/agent-hooks.md), so the hook
// prefers `envelope.task.status` and only falls back to the task store
// (`cwd` is always the project root, guaranteed by the runner) when the
// snapshot is absent (hand-built inputs). Either path keeps this file
// working verbatim.
// Contract (ADR-0007): stdin = one envelope JSON + "\n"; stdout = exactly
// one JSON document (`{"instructions":"..."}` or `{}`); diagnostics on
// stderr ONLY (a stray console.log on stdout invalidates the document and
// the runner drops the hook with HOOK_BAD_OUTPUT, fail-open).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function findTaskStatus(projectDir, taskId) {
  const roots = [join(projectDir, ".vibeflow", "tasks")];
  const target = `${taskId}.json`;
  while (roots.length > 0) {
    const dir = roots.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry === target) {
        try {
          return JSON.parse(readFileSync(full, "utf8")).status ?? null;
        } catch {
          return null;
        }
      }
      try {
        if (statSync(full).isDirectory() && entry !== "screenshots" && entry !== "files") roots.push(full);
      } catch {
        // Vanished mid-walk — ignore.
      }
    }
  }
  return null;
}

async function main() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  let envelope = null;
  try {
    envelope = JSON.parse(text.trim());
  } catch {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }
  if (envelope?.tool === "tasks" && envelope?.activity === "task.update" && envelope?.phase === "after") {
    const taskId = envelope?.payload?.taskId;
    // The snapshot suffices: the store read below only fires for
    // envelopes without one (older CLIs, hand-built inputs).
    const snapshot = envelope?.task;
    const snapshotStatus =
      snapshot !== null &&
      typeof snapshot === "object" &&
      typeof snapshot.status === "string"
        ? snapshot.status
        : null;
    const status =
      snapshotStatus ??
      (typeof taskId === "string" ? findTaskStatus(process.cwd(), taskId) : null);
    if (status === "review") {
      process.stdout.write(
        JSON.stringify({
          instructions:
            "This task just moved to review: attest the result with " +
            "`tasks --edit <id> --set-status review --set-verify pass " +
            '--comment "..."` (or --set-verify cannot --verify-reason "<why>" ' +
            "when it cannot be verified here). Never mark it done — only humans do that.",
        }) + "\n",
      );
      return;
    }
  }
  process.stdout.write(JSON.stringify({}) + "\n");
}

await main();
