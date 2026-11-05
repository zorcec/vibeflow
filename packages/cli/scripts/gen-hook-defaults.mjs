/**
 * gen-hook-defaults.mjs — generates the shipped after-hook defaults.
 *
 * Shape mirrors `scripts/gen-kanban-css.mjs`: a canonical source of truth
 * (this file) compiled into `src/core/hooks/defaults/` (committed source:
 * `after/<tool>.after.mjs` × 9 + `VERSION`) and `src/core/hooks/
 * defaults.generated.ts`, wired into `scripts/build-atomic.mjs`.
 *
 * The texts below are extracted from `renderAgentInstructions`
 * (`src/core/tasks.ts`) — UNCONDITIONAL policy text ONLY, byte-identical
 * down to indentation. Every settings-dependent (`[setting] …`, branch
 * creation, verify-before-review placement) and type-dependent
 * (research/bug rules) line stays rendered by the CLI (Sol review P1-5;
 * R1 resolved as: the CLI keeps all conditional rendering). The
 * byte-identical acceptance applies to the extracted sections only:
 * `defaults.test.ts` asserts every line below appears verbatim in
 * `src/core/tasks.ts`.
 *
 * Exactly 9 default files ship (ADR-0007 D10): a tool key gets a default
 * iff it covers ≥1 activity. A fail-open no-op `.before` default would
 * spawn a child on every gated write for nothing, and a default per
 * read-tool is dead weight — so there are NO `.before` defaults.
 * `tasks.after.mjs` switches on the envelope `activity` (one file per
 * tool, one execution per (tool, activity)); the MCP siblings carry one
 * text each; push/pull/create_task are documented no-ops.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultsDir = join(root, "src", "core", "hooks", "defaults");
const afterDir = defaultsDir;
const out = join(root, "src", "core", "hooks", "defaults.generated.ts");

export const SHIPPED_DEFAULTS_VERSION = "2";

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

const header = (tool) => `// Shipped default after-hook for "${tool}" (ADR-0007).
// Generated by scripts/gen-hook-defaults.mjs — DO NOT EDIT (read in place from the installed package; npm upgrade upgrades it).
// Override by creating .vibeflow-hooks/${tool}.after.mjs (project) or
// ~/.vibeflow/hooks/${tool}.after.mjs (global). An override REPLACES this file, never merges.
// stdin: one hook envelope JSON + "\\n". stdout: {"instructions":"..."} or {}.
`;

/**
 * Readability form (owner ticket c478fd86): one JSON string per line,
 * joined with "\\n" at load. Line-arrays — NOT template literals: a
 * template literal would need defensive backtick/`${` escaping on every
 * regeneration, while per-line JSON.stringify cannot break the emitter no
 * matter what the text contains. Mirrors SHIPPED_DEFAULT_TEXTS (line
 * arrays upstream); the joined bytes are identical to the old escaped
 * literals (proven by the /tmp byte-compare at regen time + drift tests).
 */
function linesConst(name, lines) {
  return `const ${name} = [\n${lines.map((l) => `  ${JSON.stringify(l)},`).join("\n")}\n];\n`;
}

/** @param {string} s */
function constName(s) {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/** @param {string} tool @param {Record<string, string[]>} texts activity -> lines */
function switchingHookSource(tool, texts) {
  const consts = Object.entries(texts)
    .map(([activity, lines]) => linesConst(`LINES_${constName(activity)}`, lines))
    .join("\n");
  const entries = Object.keys(texts)
    .map((activity) => `  ${JSON.stringify(activity)}: LINES_${constName(activity)}.join("\\n"),`)
    .join("\n");
  return (
    header(tool) +
    consts +
    `const TEXTS = {\n${entries}\n};\nlet input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (c) => { input += c; });\nprocess.stdin.on("end", () => {\n  let activity = null;\n  try {\n    activity = JSON.parse(input).activity ?? null;\n  } catch {\n    process.stdout.write(JSON.stringify({}) + "\\n");\n    return;\n  }\n  const text = activity !== null ? TEXTS[activity] : undefined;\n  process.stdout.write(JSON.stringify(text !== undefined ? { instructions: text } : {}) + "\\n");\n});\n`
  );
}

/** @param {string} tool @param {string[]} lines */
function textHookSource(tool, lines) {
  return (
    header(tool) +
    linesConst("LINES_TEXT", lines) +
    `const TEXT = LINES_TEXT.join("\\n");\nlet input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (c) => { input += c; });\nprocess.stdin.on("end", () => {\n  try {\n    JSON.parse(input);\n  } catch {\n    process.stdout.write(JSON.stringify({}) + "\\n");\n    return;\n  }\n  process.stdout.write(JSON.stringify({ instructions: TEXT }) + "\\n");\n});\n`
  );
}

/** @param {string} tool @param {string} why */
function noopHookSource(tool, why) {
  return (
    header(tool) +
    `// ${why}
// This default is a documented no-op: it emits {} and changes nothing.
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({}) + "\\n");
});
`
  );
}

const SOURCES = {
  "tasks.after.mjs": switchingHookSource("tasks", {
    "task.claim": CLAIM_LINES,
    "task.update": UPDATE_LINES,
    "task.comment": COMMENT_LINES,
  }),
  "update_task.after.mjs": textHookSource("update_task", UPDATE_LINES),
  "claim_next_task.after.mjs": textHookSource("claim_next_task", CLAIM_LINES),
  "add_comment.after.mjs": textHookSource("add_comment", COMMENT_LINES),
  "verify.after.mjs": textHookSource("verify", VERIFY_LINES),
  "verify_task.after.mjs": textHookSource("verify_task", VERIFY_LINES),
  "push.after.mjs": noopHookSource(
    "push",
    "No unconditional text exists for push today: the auto-push line is settings-dependent and stays rendered by the CLI.",
  ),
  "pull.after.mjs": noopHookSource(
    "pull",
    "No unconditional text exists for pull today: this default is the shape users copy.",
  ),
  "create_task.after.mjs": noopHookSource(
    "create_task",
    "No unconditional text exists for task.create today: research/bug rules are type-dependent and stay rendered by the CLI.",
  ),
};

/** tool -> activity -> lines (empty = no unconditional text). Drives the drift test. */
const TEXTS = {
  tasks: {
    "task.create": [],
    "task.update": UPDATE_LINES,
    "task.claim": CLAIM_LINES,
    "task.delete": [],
    "task.comment": COMMENT_LINES,
  },
  update_task: { "task.update": UPDATE_LINES },
  claim_next_task: { "task.claim": CLAIM_LINES },
  add_comment: { "task.comment": COMMENT_LINES },
  verify: { verify: VERIFY_LINES },
  verify_task: { verify: VERIFY_LINES },
  push: { push: [] },
  pull: { pull: [] },
  create_task: { "task.create": [] },
};

const generatedHeader = `/**
 * GENERATED by scripts/gen-hook-defaults.mjs — DO NOT EDIT.
 * Regenerate with: node scripts/gen-hook-defaults.mjs
 * Shipped after-hook default texts (ADR-0007): unconditional policy text
 * extracted from renderAgentInstructions, keyed tool -> activity so the
 * drift test can assert the text appears verbatim in src/core/tasks.ts.
 */
`;

const generatedBody = `export const SHIPPED_DEFAULTS_VERSION = ${JSON.stringify(SHIPPED_DEFAULTS_VERSION)};
export const SHIPPED_DEFAULT_TEXTS: Record<string, Record<string, string[]>> = ${JSON.stringify(TEXTS, null, 2)};
`;

mkdirSync(afterDir, { recursive: true });
for (const [name, source] of Object.entries(SOURCES)) {
  // Flat (ADR-0007 §4): the shipped root holds the files directly —
  // `defaults/tasks.after.mjs`, no `after/` subdirectory (there are no
  // `.before` defaults to separate).
  writeFileSync(join(defaultsDir, name), source);
}
writeFileSync(join(defaultsDir, "VERSION"), SHIPPED_DEFAULTS_VERSION + "\n");
writeFileSync(out, generatedHeader + generatedBody);
console.log(`wrote ${defaultsDir} (${Object.keys(SOURCES).length} files) + VERSION + ${out}`);
