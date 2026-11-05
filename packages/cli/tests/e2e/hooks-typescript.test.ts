/**
 * TypeScript hook e2e (Stage 4, ADR-0006): the shipped
 * `docs/hooks-examples/after/after-task.update.hook.ts` example copied
 * VERBATIM into a temp project and executed through the PACKAGED CLI
 * (`dist/index.js`, not src/) — proving erased type imports work at
 * runtime — plus the pre-gate phase policy for `.hook.ts` (allow lands,
 * deny blocks with the store unchanged) and loud refusal of non-erasable
 * syntax. Non-TTY trust bypass (`VIBEFLOW_TRUST_HOOKS=1`) stands in for the
 * interactive prompt, exactly as the stdio/module e2e files do.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnCliIsolated } from "./spawn-isolated.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERBATIM_EXAMPLE = join(
  CLI_ROOT,
  "..",
  "..",
  "docs",
  "hooks-examples",
  "after",
  "after-task.update.hook.ts",
);

let cliHome!: string;
let projectDir!: string;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "hookts-e2e-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "hookts-e2e-proj-"));
  ensureTaskDirs(projectDir);
});

afterEach(() => {
  rmSync(cliHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const HOOK_ENV = { VIBEFLOW_HOOKS: "1", VIBEFLOW_TRUST_HOOKS: "1" };

/** Install the shipped example VERBATIM — byte-identical, never rewritten. */
function installVerbatimExample(): void {
  const dir = join(projectDir, ".vibeflow-hooks", "after");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "after-task.update.hook.ts");
  copyFileSync(VERBATIM_EXAMPLE, dest);
  expect(readFileSync(dest, "utf8")).toBe(readFileSync(VERBATIM_EXAMPLE, "utf8"));
}

function writeAfterTsHook(body: string): void {
  const dir = join(projectDir, ".vibeflow-hooks", "after");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "after-task.update.hook.ts"), body);
}

function writePreTsHook(event: string, body: string): void {
  const dir = join(projectDir, ".vibeflow-hooks", "pre");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pre-${event}.hook.ts`), body);
}

async function addTask(title = "hook ts e2e task"): Promise<string> {
  const added = await spawnCliIsolated(
    ["tasks", "--add", "--title", title, "--json"],
    { cwd: projectDir, home: cliHome, env: HOOK_ENV },
  );
  expect(added.code).toBe(0);
  return (JSON.parse(added.stdout) as { task: { id: string } }).task.id;
}

describe("hooks-typescript e2e", () => {
  it("verbatim .hook.ts example: {} on plain edits, nudge on the review move", async () => {
    installVerbatimExample();
    const id = await addTask();
    const plain = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(plain.code).toBe(0);
    // Exactly ONE JSON document on stdout — byte-clean for piping.
    const plainDoc = JSON.parse(plain.stdout) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(plainDoc.ok).toBe(true);
    expect(plainDoc.instructions).toBeUndefined();

    const review = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "review", "--comment", "ts e2e", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(review.code).toBe(0);
    const reviewDoc = JSON.parse(review.stdout) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(reviewDoc.ok).toBe(true);
    // The review move carries its own built-in instruction alongside the
    // hook nudge — assert the hook's contribution rides along, not exclusivity.
    expect(reviewDoc.instructions?.join("\n")).toContain("attest the result");
  });

  it("an untrusted .hook.ts does not run and says why (after = skip, write lands)", async () => {
    installVerbatimExample();
    const id = await addTask();
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      // No VIBEFLOW_TRUST_HOOKS: non-TTY cannot prompt, so the hook is refused.
      { cwd: projectDir, home: cliHome, env: { VIBEFLOW_HOOKS: "1" } },
    );
    expect(edited.code).toBe(0);
    const doc = JSON.parse(edited.stdout) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(doc.ok).toBe(true);
    expect(doc.instructions).toBeUndefined();
    expect(edited.stderr).toContain("non-interactive");
  });

  it("non-erasable syntax refuses loudly, never half-runs", async () => {
    writeAfterTsHook(
      `enum Color { Red = "red" }\n` +
        `export default async () => ({ instructions: "must never run:" + Color.Red });\n`,
    );
    const id = await addTask();
    const edited = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    // After-hooks fail OPEN: the write lands, the hook is dropped loudly.
    expect(edited.code).toBe(0);
    const doc = JSON.parse(edited.stdout) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(doc.ok).toBe(true);
    expect(doc.instructions).toBeUndefined();
    expect(edited.stderr).toContain("HOOK_IMPORT_FAILED");
    expect(edited.stderr).toContain("HOOK_NONZERO_EXIT");
  });

  it("pre .hook.ts allow lands; deny blocks with the store unchanged", async () => {
    writePreTsHook(
      "task.update",
      `export default async (): Promise<{ allow: true }> => ({ allow: true });\n`,
    );
    const id = await addTask();
    const allowed = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(allowed.code).toBe(0);
    expect((JSON.parse(allowed.stdout) as { ok: boolean }).ok).toBe(true);

    writePreTsHook(
      "task.update",
      `export default async (): Promise<{ allow: false; reason: string }> => ({ allow: false, reason: "ts says no" });\n`,
    );
    const denied = await spawnCliIsolated(
      ["tasks", "--edit", id, "--set-status", "review", "--comment", "ts e2e", "--json"],
      { cwd: projectDir, home: cliHome, env: HOOK_ENV },
    );
    expect(denied.code).not.toBe(0);
    expect(denied.stdout.trim()).toBe("");
    expect(denied.stderr).toContain("HOOK_PRE_DENIED");
    expect(denied.stderr).toContain("ts says no");
    const got = await spawnCliIsolated(["tasks", "--get", id, "--json"], {
      cwd: projectDir,
      home: cliHome,
      env: HOOK_ENV,
    });
    expect(got.code).toBe(0);
    expect((JSON.parse(got.stdout) as { task: { status: string } }).task.status).toBe(
      "in-progress",
    );
  });
});
