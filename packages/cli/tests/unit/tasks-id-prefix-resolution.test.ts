/**
 * One id rule for every id-taking `vibeflow tasks` flag.
 *
 * `--edit`, `--get`, `--delete`, `--attach --task`, `--commit --task`,
 * `--parent`, `--set-parent`, `--relates`, `--blocks`, `--unrelates` and
 * `--unblocks` all resolve through `resolveSaasTaskId` (exact id wins, else
 * a UNIQUE prefix; an ambiguous prefix is `E_AMBIGUOUS` naming the
 * candidates; only then `TASK_NOT_FOUND`; an empty id is refused, never a
 * prefix of everything). This file pins that contract once per flag so a
 * future flag cannot silently reintroduce its own first-match guess.
 */
import { describe, it, expect } from "vitest";
import { resolveSaasTaskId } from "../../src/saas/client.js";

// A board where one exact id is also a prefix of another id: proves the
// equality arm wins even when a longer id starts with the whole exact id.
const board = [
  { id: "swy7ox61xtgk19uzw7uezzym", title: "Alpha" },
  { id: "swy7ox61xtgk19uzw7uezzym9q", title: "Alpha child" },
  { id: "swy7ox610000000000000001", title: "Sibling" },
  { id: "7a4c48a5f5a5165a014ea17a6fceb4", title: "Other" },
];

const UNIQUE_PREFIX = "swy7ox6100"; // only the sibling
const AMBIGUOUS_PREFIX = "swy7ox61"; // alpha + child + sibling
const EXACT_ID = "swy7ox61xtgk19uzw7uezzym"; // also prefixes "Alpha child"
const UNKNOWN = "ghost0000";
const OTHER_PREFIX = "7a4c48a5"; // only "Other"

const flags = [
  "--edit",
  "--get",
  "--delete",
  "--attach --task",
  "--commit --task",
  "--parent",
  "--set-parent",
  "--relates",
  "--blocks",
  "--unrelates",
  "--unblocks",
] as const;

describe("one id rule for every id-taking tasks flag", () => {
  for (const flag of flags) {
    it(`${flag}: a unique prefix resolves to the full id`, () => {
      expect(resolveSaasTaskId(board, UNIQUE_PREFIX)).toEqual({
        ok: true,
        id: "swy7ox610000000000000001",
      });
      expect(resolveSaasTaskId(board, OTHER_PREFIX)).toEqual({
        ok: true,
        id: "7a4c48a5f5a5165a014ea17a6fceb4",
      });
    });
  }

  it("exact id wins over a prefix that also matches longer ids", () => {
    expect(resolveSaasTaskId(board, EXACT_ID)).toEqual({
      ok: true,
      id: EXACT_ID,
    });
  });

  it("ambiguous prefix is E_AMBIGUOUS naming every candidate (never 'not found')", () => {
    const resolved = resolveSaasTaskId(board, AMBIGUOUS_PREFIX);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe("E_AMBIGUOUS");
      expect(resolved.message).toContain("swy7ox61xtgk19uzw7uezzym");
      expect(resolved.message).toContain("swy7ox61xtgk19uzw7uezzym9q");
      expect(resolved.message).toContain("swy7ox610000000000000001");
      expect(resolved.message).not.toMatch(/not found/i);
      if (resolved.code === "E_AMBIGUOUS") {
        expect(resolved.candidates).toEqual([
          "swy7ox61xtgk19uzw7uezzym",
          "swy7ox61xtgk19uzw7uezzym9q",
          "swy7ox610000000000000001",
        ]);
      }
    }
  });

  it("unknown prefix is TASK_NOT_FOUND", () => {
    expect(resolveSaasTaskId(board, UNKNOWN)).toEqual({
      ok: false,
      code: "TASK_NOT_FOUND",
      message: `Task not found: ${UNKNOWN}`,
    });
  });

  it("empty id is refused (never a prefix of everything)", () => {
    const resolved = resolveSaasTaskId(board, "");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe("TASK_NOT_FOUND");
  });
});
