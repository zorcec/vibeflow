/**
 * gen-hook-defaults.mjs — generates the shipped after-hook defaults.
 *
 * Shape mirrors `scripts/gen-kanban-css.mjs`: a canonical source of truth
 * (this file) compiled into `src/core/hooks/defaults.generated.ts`, wired
 * into `scripts/build-atomic.mjs`. The texts below are extracted from
 * `renderAgentInstructions` (`src/core/tasks.ts`) — UNCONDITIONAL policy
 * text ONLY, byte-identical down to indentation. Every settings-dependent
 * (`[setting] …`, branch creation, verify-before-review placement) and
 * type-dependent (research/bug rules) line stays rendered by the CLI (Sol
 * review P1-5; R1 resolved as: the CLI keeps all conditional rendering).
 * The byte-identical acceptance applies to the extracted sections only:
 * `defaults.test.ts` asserts every line below appears verbatim in
 * `src/core/tasks.ts`.
 *
 * Events with no unconditional text today (create, delete, push, pull)
 * ship as DOCUMENTED NO-OPS — the shape users copy — not as invented
 * policy. In particular `task.create` carries no research rules: those are
 * type-dependent and stay rendered by the CLI.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src", "core", "hooks", "defaults.generated.ts");

export const DEFAULT_HOOKS_VERSION = "1";

const CLAIM_LINES = [
  "  Workflow:",
  "    ⚠ IMMEDIATELY set in-progress BEFORE any implementation work:",
  "    1. vibeflow tasks --edit <id> --set-status in-progress  ← DO THIS FIRST",
  "       (if you used --next: task is already in-progress — skip to step 2)",
  "    2. <implement the change>",
  "  BLOCKED? If a task is unclear or missing context:",
  '    vibeflow tasks --edit <id> --comment "Blocked: <reason>. Need: <what is needed>."',
  "    Then pick the next task: vibeflow tasks --next",
  "    Do not guess at unclear requirements — leave a comment and move on.",
  "  CRITICAL: Set in-progress BEFORE reading/planning. Other agents may pick the same task.",
  "    The in-progress transition signals ownership. Skip it and another agent may duplicate your work.",
  "    Sequence: discover tasks → pick one → set in-progress → THEN read details and implement.",
];

const UPDATE_LINES = [
  '  CRITICAL: NEVER set a task status to "done".',
  '    When your implementation is complete, set the status to "review" — not "done".',
  "    Only humans can mark tasks as done after reviewing the work.",
  "    The CLI will warn you and still allow the change — but agents must not use it.",
  "  CRITICAL: NEVER edit .vibeflow/ task files directly.",
  "    All task operations (status, comments, commits) must go through CLI commands.",
];

const COMMENT_LINES = [
  "  Comment format (--comment):",
  "    · Plain text for concise one-liners.",
  "    · Markdown for multi-section reports. Use **bold**, bullet lists, code fences.",
  "    · Must cover: what changed, why, key decisions, anything future agents should know.",
  "    · For long reports, attach a .md file and reference it in the comment.",
];

const VERIFY_LINES = [
  "       ALWAYS attempt verification — even with no baseline and no ground truth. Verify what you CAN:",
  "       does the artifact actually satisfy what this ticket asked?",
  "       Annotated UI task (URL + selector): run 'vibeflow verify <id>' AND reason about the result.",
  "       verify only checks that your annotated element still resolves and that the page logged",
  "       no NEW console errors. It CANNOT tell whether you did what the ticket asked — YOU judge that.",
  "       Counterexamples that PASS verify but are still WRONG: making a button green when the ticket",
  "       said red, or fixing a different bug than the ticket describes.",
  "       Non-UI task (docs, rename, copy, links, config): no automated check exists — inspect the artifact",
  "       yourself, e.g. rename → grep the old string and assert ZERO occurrences; links → resolve every",
  "       href and assert none 404; README → confirm every referenced file exists and is actually shipped",
  "       in the package's files list; command reference → confirm each documented command exists in --help.",
  "       Did you actually accomplish the task? If not, set it back to in-progress and fix it.",
  "       If the task genuinely CANNOT be verified here, declare it so no badge shows:",
  '         vibeflow tasks --edit <id> --set-verify cannot --verify-reason "<why>"',
  "       (cannot records no verdict or badge — the honest state for an unverifiable task; the reason",
  "       is recorded in the task's activity. --set-verify fail means you verified it is WRONG.)",
  "       Never submit work you know is incomplete.",
  "       --set-verify pass is YOUR attestation that the task IS implemented correctly. The review gate",
  "       requires a verdict on annotated (URL + selector) tasks. If you verified and the task is",
  "       WRONG, record --set-verify fail — that does NOT pass the gate; fix the work first.",
];

/** @param {string} event @param {string[]} lines */
function textHookSource(event, lines) {
  const encoded = JSON.stringify(lines.join("\n"));
  return `// Shipped default after-hook for "${event}" (Stage 1, ADR-0006).
// Generated by scripts/gen-hook-defaults.mjs — DO NOT EDIT (regenerated on upgrade; edits are lost).
// Override by creating .vibeflow-hooks/after/${event}.mjs (project) or
// ~/.vibeflow/hooks/after/${event}.mjs (global). An override REPLACES this file, never merges.
// stdin: one hook envelope JSON + "\\n". stdout: {"instructions":"..."} or {}.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  try {
    JSON.parse(input);
  } catch {
    process.stdout.write(JSON.stringify({}) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ instructions: ${encoded} }) + "\\n");
});
`;
}

/** @param {string} event @param {string} why */
function noopHookSource(event, why) {
  return `// Shipped default after-hook for "${event}" (Stage 1, ADR-0006).
// Generated by scripts/gen-hook-defaults.mjs — DO NOT EDIT (regenerated on upgrade; edits are lost).
// ${why}
// Override by creating .vibeflow-hooks/after/${event}.mjs (project) or
// ~/.vibeflow/hooks/after/${event}.mjs (global). An override REPLACES this file, never merges.
// This default is a documented no-op: it emits {} and changes nothing.
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({}) + "\\n");
});
`;
}

const SOURCES = {
  "task.claim": textHookSource("task.claim", CLAIM_LINES),
  "task.update": textHookSource("task.update", UPDATE_LINES),
  "task.comment": textHookSource("task.comment", COMMENT_LINES),
  verify: textHookSource("verify", VERIFY_LINES),
  "task.create": noopHookSource(
    "task.create",
    "No unconditional text exists for task.create today: research/bug rules are type-dependent and stay rendered by the CLI.",
  ),
  "task.delete": noopHookSource(
    "task.delete",
    "No unconditional text exists for task.delete today: this default is the shape users copy.",
  ),
  push: noopHookSource(
    "push",
    "No unconditional text exists for push today: the auto-push line is settings-dependent and stays rendered by the CLI.",
  ),
  pull: noopHookSource(
    "pull",
    "No unconditional text exists for pull today: this default is the shape users copy.",
  ),
};

const LINES = {
  "task.claim": CLAIM_LINES,
  "task.update": UPDATE_LINES,
  "task.comment": COMMENT_LINES,
  verify: VERIFY_LINES,
  "task.create": [],
  "task.delete": [],
  push: [],
  pull: [],
};

const header = `/**
 * GENERATED by scripts/gen-hook-defaults.mjs — DO NOT EDIT.
 * Regenerate with: node scripts/gen-hook-defaults.mjs
 * Shipped after-hook defaults (Stage 1, ADR-0006): unconditional policy
 * text extracted from renderAgentInstructions, plus documented no-ops.
 */
`;

const body = `export const DEFAULT_HOOKS_VERSION = ${JSON.stringify(DEFAULT_HOOKS_VERSION)};
export const DEFAULT_HOOK_LINES: Record<string, string[]> = ${JSON.stringify(LINES, null, 2)};
export const DEFAULT_HOOK_SOURCES: Record<string, string> = ${JSON.stringify(SOURCES, null, 2)};
`;

writeFileSync(out, header + body);
console.log(`wrote ${out}`);
