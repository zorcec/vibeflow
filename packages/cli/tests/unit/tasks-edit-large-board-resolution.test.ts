/**
 * Regression test (ticket ck1kysdzwdasbl7wn9qqkics): `--edit` (and every
 * other id-taking flag) must resolve a full task id no matter where it
 * sorts on the board — never against a truncated first-page candidate
 * list (default display limit 20).
 *
 * The unit file `tasks-id-prefix-resolution.test.ts` pins the pure rule
 * (`resolveSaasTaskId`) on a 4-task board; it cannot see a caller feeding
 * the rule a bounded listing. This file pins the CALLER side on a
 * 30-task board: the exact candidate shapes the CLI local `--edit`
 * branch (`resolveSaasTaskId` over the FULL `listTasks`) and the
 * operations/MCP path (`LocalTaskStore.resolveTask` → `resolveLocalTask`)
 * resolve through, with the target chosen to sort outside the first
 * 20 ids. A truncation control proves the setup bites: the same late id
 * resolved against only the first 20 candidates MUST miss, so a future
 * bounded-listing regression fails this suite instead of shipping
 * TASK_NOT_FOUND for valid ids.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listTasks, resolveLocalTask } from "../../src/core/tasks.js";
import { resolveSaasTaskId } from "../../src/core/id-resolution.js";
import { LocalTaskStore } from "../../src/core/task-store.js";

const BOARD_SIZE = 30;
const FIRST_PAGE = 20;

// Fixed-width filler ids sort before the target and never prefix-collide
// with each other, the target, or the ambiguity pair below.
const fillerId = (n: number) => `fill-${String(n).padStart(4, "0")}-task`;
const TARGET_ID = "zzz-late-target-001";
const AMB_A = "amb-0001-alpha";
const AMB_B = "amb-0001-beta";
const AMB_PREFIX = "amb-0001";
const TARGET_PREFIX = "zzz-late";

function writeTask(dir: string, id: string, title: string, status = "todo") {
  const tasksDir = join(dir, ".vibeflow", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, `${id}.json`),
    JSON.stringify({
      id,
      title,
      description: `${title} description`,
      status,
      selector: "/",
      created: "2026-01-01T00:00:00.000Z",
    }),
  );
}

describe("id resolution on a board larger than one display page", () => {
  let dir: string;
  let store: LocalTaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibeflow-large-board-"));
    store = new LocalTaskStore();
    for (let n = 0; n < BOARD_SIZE - 3; n++) {
      writeTask(dir, fillerId(n), `Filler ${n}`);
    }
    writeTask(dir, AMB_A, "Ambiguity A");
    writeTask(dir, AMB_B, "Ambiguity B");
    writeTask(dir, TARGET_ID, "Late target");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("the target sorts outside the first page of board ids", () => {
    const sorted = listTasks(dir)
      .map((t) => t.id)
      .sort();
    expect(sorted).toHaveLength(BOARD_SIZE);
    expect(sorted.slice(0, FIRST_PAGE)).not.toContain(TARGET_ID);
    expect(sorted[sorted.length - 1]).toBe(TARGET_ID);
  });

  it("CLI --edit shape: every full id resolves against the full listing", () => {
    // Mirrors the local `--edit` branch: `resolveSaasTaskId` over the
    // FULL `listTasks`, not a display page.
    const candidates = listTasks(dir).map((t) => ({ id: t.id, title: t.title }));
    expect(candidates).toHaveLength(BOARD_SIZE);
    for (const task of listTasks(dir)) {
      const resolved = resolveSaasTaskId(candidates, task.id);
      expect(resolved).toEqual({ ok: true, id: task.id });
    }
  });

  it("operations/MCP shape: every full id resolves through the store port", async () => {
    for (const task of listTasks(dir)) {
      const outcome = await store.resolveTask(dir, task.id);
      expect(outcome.status).toBe("found");
      if (outcome.status === "found") expect(outcome.id).toBe(task.id);
    }
    // The ticket's repro id shape: full id late on the board.
    const late = await store.resolveTask(dir, TARGET_ID);
    expect(late.status).toBe("found");
    const direct = resolveLocalTask(dir, TARGET_ID);
    expect(direct.status).toBe("found");
  });

  it("truncation control: the late id misses against a first-20 candidate list", () => {
    // Proves this suite is non-vacuous: if a caller ever feeds the rule a
    // bounded first-page listing again, the late id resolves to exactly
    // the TASK_NOT_FOUND the ticket reported.
    const sorted = listTasks(dir)
      .map((t) => ({ id: t.id, title: t.title }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const firstPage = sorted.slice(0, FIRST_PAGE);
    expect(firstPage.map((t) => t.id)).not.toContain(TARGET_ID);
    const truncated = resolveSaasTaskId(firstPage, TARGET_ID);
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.code).toBe("TASK_NOT_FOUND");
  });

  it("a unique short prefix still resolves; an ambiguous one still refuses", async () => {
    const candidates = listTasks(dir).map((t) => ({ id: t.id, title: t.title }));
    expect(resolveSaasTaskId(candidates, TARGET_PREFIX)).toEqual({
      ok: true,
      id: TARGET_ID,
    });
    const ambiguous = resolveSaasTaskId(candidates, AMB_PREFIX);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.code).toBe("E_AMBIGUOUS");
      if (ambiguous.code === "E_AMBIGUOUS") {
        expect(ambiguous.candidates).toEqual(
          expect.arrayContaining([AMB_A, AMB_B]),
        );
      }
    }
    const storeAmbiguous = await store.resolveTask(dir, AMB_PREFIX);
    expect(storeAmbiguous.status).toBe("ambiguous");
  });
});
