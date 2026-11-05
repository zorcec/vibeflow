// Example module after-hook in TypeScript: nudge the agent when a task
// moves to review.
//
// Copy VERBATIM to `.vibeflow-hooks/after/after-task.update.hook.ts`.
// Removal restores the shipped default for `task.update` (ADR-0006:
// project beats global beats default, first hit wins, REPLACE never merge).
//
// What it does: when the confirmed update left the task in `review`, it
// returns one `instructions` string reminding the agent to attest the review
// verdict. Any other update returns `{}` (no-op). Pure and offline: no
// network, no config file, no secrets — and NEVER a Vibeflow token.
//
// TypeScript rules (Stage 4, ADR-0006) — type stripping, NOT compilation:
// - Erasable syntax ONLY: annotations and `import type` are erased, the
//   rest of the file must be plain runnable JavaScript. NO enums, NO
//   namespaces, NO parameter properties, NO JSX, NO tsconfig paths.
// - `import type` is erased before resolution — it never needs to resolve
//   at runtime (but keep the local dev dependency so editors resolve it:
//   `npm install --save-dev @vibeflow-tools/cli`).
//
// Why it reads the task file: in the current build the AFTER envelope
// carries the confirmed effect in `payload` (`{taskId, changed}`) while
// `task` is null — the full snapshot rides the PRE envelope only (see
// docs/agent-hooks.md). So this hook looks up the fresh status from the
// task store (`cwd` is always the project root, guaranteed by the runner).
//
// Contract (ADR-0006): the loader calls the default export with the full
// envelope as its ONE argument; return `{instructions: "..."}` or `{}`.
// A `console.log` lands on child stdout, invalidates the document, and the
// runner drops the hook with HOOK_BAD_OUTPUT (fail-open).

import type {
  HookAfterEnvelope,
  HookAfterResult,
} from "@vibeflow-tools/cli/hooks";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function findTaskStatus(projectDir: string, taskId: string): string | null {
  const roots: string[] = [join(projectDir, ".vibeflow", "tasks")];
  const target: string = `${taskId}.json`;
  while (roots.length > 0) {
    const dir: string = roots.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full: string = join(dir, entry);
      if (entry === target) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(full, "utf8"));
          if (parsed !== null && typeof parsed === "object") {
            const status: unknown = (parsed as Record<string, unknown>)["status"];
            return typeof status === "string" ? status : null;
          }
          return null;
        } catch {
          return null;
        }
      }
      let isDir = false;
      try {
        isDir =
          statSync(full).isDirectory() &&
          entry !== "screenshots" &&
          entry !== "files";
      } catch {
        // Vanished mid-walk — ignore.
      }
      if (isDir) roots.push(full);
    }
  }
  return null;
}

export default async function (
  envelope: HookAfterEnvelope<"task.update">,
): Promise<HookAfterResult> {
  if (envelope.event === "task.update" && envelope.phase === "after") {
    const taskId: string = envelope.payload.taskId;
    if (
      typeof taskId === "string" &&
      findTaskStatus(process.cwd(), taskId) === "review"
    ) {
      return {
        instructions:
          "This task just moved to review: attest the result with " +
          "`tasks --edit <id> --set-status review --set-verify pass " +
          '`--comment "..."` (or --set-verify cannot --verify-reason "<why>" ' +
          "when it cannot be verified here). Never mark it done — only humans do that.",
      };
    }
  }
  return {};
}
