// Example after-hook: nudge the agent when a task moves to review.
//
// Copy VERBATIM to `.vibeflow-hooks/after/after-task.update.mjs`.
// Removal restores the shipped default for `task.update` (ADR-0006:
// project beats global beats default, first hit wins, REPLACE never merge).
//
// What it does: when the confirmed update left the task in `review`, it
// returns one `instructions` string reminding the agent to attest the review
// verdict. Any other update returns `{}` (no-op). Pure and offline: no
// network, no config file, no secrets — and NEVER any Vibeflow token.
//
// Why it reads the task file: in the current build the AFTER envelope
// carries the confirmed effect in `payload` (`{taskId, changed}`) while
// `task` is null — the full snapshot rides the PRE envelope only (see
// docs/agent-hooks.md). So this hook looks up the fresh status from the
// task store (`cwd` is always the project root, guaranteed by the runner).
// Contract (ADR-0006): stdin = one envelope JSON + "\n"; stdout = exactly
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
  if (envelope?.event === "task.update" && envelope?.phase === "after") {
    const taskId = envelope?.payload?.taskId;
    if (typeof taskId === "string" && findTaskStatus(process.cwd(), taskId) === "review") {
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
