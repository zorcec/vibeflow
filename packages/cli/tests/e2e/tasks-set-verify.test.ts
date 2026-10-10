/**
 * CLI e2e — the tri-state verification verdict flag `--set-verify` in isolation.
 *
 * `tasks --edit <id> --set-verify <verdict>` must write the verdict (or clear
 * for "cannot"), and the flag must never silently no-op — a verdict with no
 * other edit still counts as an edit. Review transitions covered here: pass →
 * allowed, fail → blocked, cannot+reason → allowed (reason recorded), omitted
 * on an annotated task → blocked with an error naming all three options, and
 * cannot without --verify-reason → rejected. Non-annotated tasks stay ungated.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCli } from "./mcp-helpers.js";
import { RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL } from "../../src/core/review-gate.js";

const cleanups: Array<() => void> = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function taskFile(projectDir: string, taskId: string): string {
  const tasksDir = join(projectDir, ".vibeflow", "tasks");
  for (const entry of readdirSync(tasksDir)) {
    const candidate = join(tasksDir, entry, `${taskId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`task file not found for ${taskId}`);
}

function storedVerified(projectDir: string, taskId: string): unknown {
  return JSON.parse(readFileSync(taskFile(projectDir, taskId), "utf-8"))
    .verified;
}

function storedComments(projectDir: string, taskId: string): Array<{ text: string; type?: string }> {
  return (JSON.parse(readFileSync(taskFile(projectDir, taskId), "utf-8"))
    .comments ?? []) as Array<{ text: string; type?: string }>;
}

async function addTask(
  store: string,
  home: string,
  title: string,
  extra: string[] = [],
): Promise<string> {
  const add = await spawnCli(
    ["tasks", store, "--add", "--title", title, "--json", ...extra],
    { cwd: store, home },
  );
  return JSON.parse(add.stdout).task.id;
}

/** Seed an annotated task (url + selector) directly. */
function seedAnnotatedTask(store: string, id: string): void {
  const tasksDir = join(store, ".vibeflow", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(join(tasksDir, "2025-01-01"), { recursive: true });
  writeFileSync(
    join(tasksDir, "2025-01-01", `${id}.json`),
    JSON.stringify(
      {
        id,
        title: "Annotated gate task",
        description: "",
        status: "in-progress",
        type: "Task",
        priority: "Medium",
        selector: ".submit-btn",
        cssSelector: ".submit-btn",
        url: "https://example.com",
        created: "2025-01-01T10:00:00.000Z",
      },
      null,
      2,
    ),
  );
}

/** Turn the verify gate ON for the store. */
function enableVerifyGate(store: string): void {
  const protoDir = join(store, ".vibeflow");
  mkdirSync(protoDir, { recursive: true });
  writeFileSync(
    join(protoDir, "settings.json"),
    JSON.stringify({
      autoCommit: false,
      autoComment: false,
      autoPush: false,
      createBranch: false,
      requireVerifyBeforeReview: true,
    }),
  );
}

/** Seed a Research task (no annotated UI to verify) directly. */
function seedResearchTask(store: string, id: string): void {
  const tasksDir = join(store, ".vibeflow", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(join(tasksDir, "2025-01-01"), { recursive: true });
  writeFileSync(
    join(tasksDir, "2025-01-01", `${id}.json`),
    JSON.stringify(
      {
        id,
        title: "Research task",
        description: "",
        status: "in-progress",
        type: "Research",
        priority: "Medium",
        selector: "/",
        created: "2025-01-01T10:00:00.000Z",
      },
      null,
      2,
    ),
  );
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("tasks --edit --set-verify", () => {
  it("--set-verify pass alone attests true (no silent no-op)", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Attest me");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "pass", "--json"],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    expect(storedVerified(store, id)).toBe(true);
  });

  it("--set-verify fail alone records false (a completed negative verdict)", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Fail me");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "fail", "--json"],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    expect(storedVerified(store, id)).toBe(false);
  });

  it("--set-verify cannot + --verify-reason clears to absent and records the reason", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Unverifiable");
    await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "pass", "--json"],
      { cwd: store, home },
    );
    expect(storedVerified(store, id)).toBe(true);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-verify",
        "cannot",
        "--verify-reason",
        "no browser in this environment",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    // Absent — the key is dropped from the on-disk JSON, not `false`/`null`.
    expect(storedVerified(store, id)).toBeUndefined();
    expect(
      "verified" in JSON.parse(readFileSync(taskFile(store, id), "utf-8")),
    ).toBe(false);
    // The reason is recorded as a system activity item for the detail panel.
    const texts = storedComments(store, id).map((c) => c.text);
    expect(
      texts.some(
        (t) =>
          t.includes("Cannot verify") &&
          t.includes("no browser in this environment"),
      ),
    ).toBe(true);
  });

  it("--set-verify cannot WITHOUT --verify-reason is rejected and writes nothing", async () => {    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Missing reason");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "cannot", "--json"],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    // The defect this asserts against: under --json the refusal used to print
    // human prose on stdout, so a machine consumer saw no error code at all.
    // stdout must carry nothing and the code must reach stderr.
    expect(r.stdout.trim()).toBe("");
    const envelope = JSON.parse(r.stderr);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("VERIFY_REASON_REQUIRED");
    expect(envelope.error.message).toContain("--verify-reason");
    // Nothing written — the store stays absent.
    expect(storedVerified(store, id)).toBeUndefined();
  });

  it("the HUMAN path prints the attestation suggestion too, not just the --json one", async () => {
    // The attestation contract carries a `suggestion`, and the --json envelope
    // above receives it — but the human branch printed the message alone, so a
    // human agent (or an agent reading a transcript) got "cannot requires a
    // reason" with nowhere to put it. The gate branch already printed it; this
    // is the same line on the attestation branch.
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Missing reason, human mode");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "cannot"],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    const printed = `${r.stdout}\n${r.stderr}`;
    expect(printed).toContain("--verify-reason");
    // Where to put it, on both surfaces — the same text the --json envelope
    // carries, so the two outputs cannot disagree.
    expect(printed).toContain("verifyReason");
    expect(printed).toContain("setVerify");
    // And still nothing written.
    expect(storedVerified(store, id)).toBeUndefined();
  });

  it("all three RESEARCH_VERIFY_NOT_ALLOWED producers say it the same way", async () => {
    // The rule ("a Research task takes no verdict") is enforced in three
    // places: the review gate, the CLI's standalone `--set-verify` check with
    // --json, and that same check's human printer. All three carried the same
    // sentence copied out longhand, so one edit left the others stale. The
    // gate's wording is now the single definition (unit-pinned in
    // review-gate.test.ts); this pins the two CLI copies to it.
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = "dddddddddddddddddddddddddddddd";
    seedResearchTask(store, id);

    const json = await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "pass", "--json"],
      { cwd: store, home },
    );
    expect(json.code).not.toBe(0);
    const envelope = JSON.parse(json.stderr);
    // The envelope carries `ok`/`retryable` of its own, so the three fields
    // the rule owns are compared one by one rather than by whole object.
    expect(envelope.error.code).toBe(RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.code);
    expect(envelope.error.message).toBe(
      RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.message,
    );
    expect(envelope.error.suggestion).toBe(
      RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.suggestion,
    );

    const human = await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "pass"],
      { cwd: store, home },
    );
    expect(human.code).not.toBe(0);
    const printed = `${human.stdout}\n${human.stderr}`;
    expect(printed).toContain(RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.message);
    expect(printed).toContain(RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.suggestion);

    // Still nothing written.
    expect(storedVerified(store, id)).toBeUndefined();
  });

  it("--verify-reason without --set-verify cannot is rejected", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Orphan reason");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-verify",
        "pass",
        "--verify-reason",
        "why?",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    // Same defect as above: the flag-combination usage error must be a code on
    // stderr, not prose on stdout.
    expect(r.stdout.trim()).toBe("");
    const envelope = JSON.parse(r.stderr);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_USAGE");
    expect(envelope.error.message).toContain("--set-verify cannot");
  });

  it("omitting a verdict on an annotated task blocks review with an error naming all three options", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    enableVerifyGate(store);
    const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    seedAnnotatedTask(store, id);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--comment",
        "done",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    // Gate refusals under --json are the error envelope on stderr; stdout
    // stays empty (no human prose next to the would-be success payload).
    expect(r.stdout.trim()).toBe("");
    const verifyRequired = JSON.parse(r.stderr);
    expect(verifyRequired.ok).toBe(false);
    expect(verifyRequired.error.code).toBe("VERIFY_REQUIRED");
    expect(r.stderr).toContain("--set-verify pass");
    expect(r.stderr).toContain("--set-verify fail");
    expect(r.stderr).toContain("--set-verify cannot");
    const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
    expect(onDisk.status).toBe("in-progress");
  });

  it("--set-verify cannot + reason allows review of an annotated task", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    enableVerifyGate(store);
    const id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    seedAnnotatedTask(store, id);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--set-verify",
        "cannot",
        "--verify-reason",
        "behind corporate SSO",
        "--comment",
        "done",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
    expect(onDisk.status).toBe("review");
    expect(onDisk.verified).toBeUndefined();
    const texts = (onDisk.comments ?? []).map((c: { text: string }) => c.text);
    expect(
      texts.some((t: string) => t.includes("behind corporate SSO")),
    ).toBe(true);
  });

  it("--set-verify fail blocks review of an annotated task", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    enableVerifyGate(store);
    const id = "cccccccccccccccccccccccccccccc";
    seedAnnotatedTask(store, id);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--set-verify",
        "fail",
        "--comment",
        "it is wrong",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    const failedAttested = JSON.parse(r.stderr);
    expect(failedAttested.ok).toBe(false);
    expect(failedAttested.error.code).toBe("VERIFY_FAILED_ATTESTED");
    expect(r.stderr).toContain("NOT implemented correctly");
    const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
    expect(onDisk.status).toBe("in-progress");
    // The gate ran BEFORE any write — the negative verdict was never applied.
    expect(onDisk.verified).toBeUndefined();
  });

  it("non-annotated tasks stay ungated — review without a verdict is allowed", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    enableVerifyGate(store);
    // `tasks --add` creates non-annotated tasks (selector "/", no url).
    const id = await addTask(store, home, "No annotation");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--comment",
        "done",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
    expect(onDisk.status).toBe("review");
    expect(onDisk.verified).toBeUndefined();
  });

  // ── The Research verdict rule, at the CLI boundary ───────────────────────
  // The refusal itself is pinned in review-gate.test.ts (the gate's own
  // return) and in operations-verify-attestation.test.ts (the MCP path).
  // What these two cases add is the WRITE: a refusal that still wrote the
  // value — or wrote the reason comment, or moved the status — would satisfy
  // every one of those tests while leaving the task in the state the rule
  // exists to prevent.

  for (const verdict of ["pass", "fail"] as const) {
    it(`standalone --set-verify ${verdict} on a Research task is refused, and nothing is written`, async () => {
      const store = freshDir("set-verify-");
      const home = freshDir("set-verify-home-");
      const id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      seedResearchTask(store, id);

      const r = await spawnCli(
        ["tasks", store, "--edit", id, "--set-verify", verdict, "--json"],
        { cwd: store, home },
      );

      expect(r.code).not.toBe(0);
      const envelope = JSON.parse(r.stderr);
      expect(envelope.error.code).toBe(RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.code);
      // The whole refusal travels, so a consumer does not have to guess why.
      expect(envelope.error.message).toBe(
        RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.message,
      );
      expect(envelope.error.suggestion).toBe(
        RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.suggestion,
      );
      const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
      // No verdict on disk, no status change, no comment — no side effect at
      // all, which is what separates this from the old silent scrub.
      expect("verified" in onDisk).toBe(false);
      expect(onDisk.status).toBe("in-progress");
      expect(onDisk.comments ?? []).toEqual([]);
    });
  }

  it("standalone --set-verify cannot + --verify-reason on a Research task is refused, and records no reason", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = "ffffffffffffffffffffffffffffff";
    seedResearchTask(store, id);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-verify",
        "cannot",
        "--verify-reason",
        "no browser here",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stderr).error.code).toBe(
      RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.code,
    );
    const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
    // `cannot` on a verifiable task records the reason as an activity item; on
    // a Research task even that must not appear, or the task ends up with a
    // verdict-shaped audit trail.
    expect("verified" in onDisk).toBe(false);
    expect(onDisk.comments ?? []).toEqual([]);
  });

  it("a verdict on a Research review transition is still refused, before the report gate", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeef";
    seedResearchTask(store, id);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--set-verify",
        "pass",
        "--comment",
        "report ready",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    const envelope = JSON.parse(r.stderr);
    // Gate order is comment → commit → branch → verify → research, so a task
    // with no .md attached must still refuse on the VERDICT, not on the
    // missing report — otherwise the verdict rule would be unreachable here.
    expect(envelope.error.code).toBe(RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL.code);
    const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
    expect(onDisk.status).toBe("in-progress");
    expect("verified" in onDisk).toBe(false);
  });

  it("Bug and Feature tasks still take every verdict — the refusal is Research-specific", async () => {
    for (const type of ["Bug", "Feature"] as const) {
      const store = freshDir("set-verify-");
      const home = freshDir("set-verify-home-");
      const id = await addTask(store, home, `Typed ${type}`, ["--type", type]);

      const pass = await spawnCli(
        ["tasks", store, "--edit", id, "--set-verify", "pass", "--json"],
        { cwd: store, home },
      );
      expect(pass.code, `${type} pass`).toBe(0);
      expect(storedVerified(store, id), `${type} pass`).toBe(true);

      const fail = await spawnCli(
        ["tasks", store, "--edit", id, "--set-verify", "fail", "--json"],
        { cwd: store, home },
      );
      expect(fail.code, `${type} fail`).toBe(0);
      expect(storedVerified(store, id), `${type} fail`).toBe(false);

      const cannot = await spawnCli(
        [
          "tasks",
          store,
          "--edit",
          id,
          "--set-verify",
          "cannot",
          "--verify-reason",
          "behind SSO",
          "--json",
        ],
        { cwd: store, home },
      );
      expect(cannot.code, `${type} cannot`).toBe(0);
      // Absent, and the reason is recorded — the normal tri-state behaviour
      // the Research rule must not have broken on the way past.
      expect(storedVerified(store, id), `${type} cannot`).toBeUndefined();
      expect(
        storedComments(store, id).some((c) => c.text.includes("behind SSO")),
        `${type} cannot reason`,
      ).toBe(true);
    }
  });
});