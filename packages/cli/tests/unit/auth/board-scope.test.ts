import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveBoardScope,
  BoardScopeRequiredError,
  type BoardScopeDeps,
  type BoardSummary,
} from "../../../src/auth/board-scope.js";

afterEach(() => vi.clearAllMocks());

const BOARD_A: BoardSummary = { id: "board-1753", name: "Main" };
const BOARD_B: BoardSummary = { id: "board-900", name: "Second" };

/**
 * Deps factory with all three seams replaced — resolveBoardScope under test
 * must never touch fs or the network. Callers may override individual seams;
 * unused seams are spies so "not consulted" assertions work.
 */
function makeDeps(overrides: {
  saved?: { id: string } | null;
  hasToken?: boolean;
  boards?: BoardSummary[];
} = {}): BoardScopeDeps & {
  hasToken: ReturnType<typeof vi.fn>;
  readSavedBoard: ReturnType<typeof vi.fn>;
  listBoards: ReturnType<typeof vi.fn>;
} {
  return {
    hasToken: vi.fn(async () => overrides.hasToken ?? true),
    readSavedBoard: vi.fn(
      async () => overrides.saved ?? null,
    ),
    listBoards: vi.fn(async () => overrides.boards ?? []),
  };
}

const PROJ = "/test-project";

describe("resolveBoardScope", () => {
  it("(a) explicit flag wins over saved board and is trimmed", async () => {
    const deps = makeDeps({ saved: { id: "saved-board" }, hasToken: false });

    const result = await resolveBoardScope("  board-flag  ", PROJ, deps);

    expect(result).toBe("board-flag");
    // The flag short-circuits: saved board, token, and board listing are
    // never consulted.
    expect(deps.readSavedBoard).not.toHaveBeenCalled();
    expect(deps.hasToken).not.toHaveBeenCalled();
    expect(deps.listBoards).not.toHaveBeenCalled();
  });

  it("(b) saved board is used when no flag is given", async () => {
    const deps = makeDeps({ saved: { id: "saved-1" } });

    const result = await resolveBoardScope(null, PROJ, deps);

    expect(result).toBe("saved-1");
    // Saved selection ends the resolution — no listing request.
    expect(deps.listBoards).not.toHaveBeenCalled();
  });

  it("(c) auto-selects ONLY when the account has exactly one board", async () => {
    const single = makeDeps({ boards: [BOARD_A] });
    expect(await resolveBoardScope(undefined, PROJ, single)).toBe(BOARD_A.id);
    expect(single.listBoards).toHaveBeenCalledTimes(1);

    // Zero boards is NOT an auto-selection either — there is nothing to
    // pick, so resolution falls through to the unscoped path (null).
    const empty = makeDeps({ boards: [] });
    expect(await resolveBoardScope(undefined, PROJ, empty)).toBeNull();
  });

  it("(d) 2+ boards with no selection throws BoardScopeRequiredError listing BOTH ids", async () => {
    const deps = makeDeps({ boards: [BOARD_A, BOARD_B] });

    let caught: unknown = null;
    try {
      await resolveBoardScope(null, PROJ, deps);
    } catch (err) {
      caught = err;
    }

    // SAFETY PROPERTY: a wrong-board push moves the whole local store
    // (1753 tasks) to the wrong board — a 2+ board account must NEVER get
    // a guess, and the refusal must name every candidate so the user can
    // re-run with --board.
    expect(caught).toBeInstanceOf(BoardScopeRequiredError);
    const err = caught as BoardScopeRequiredError;
    expect(err.message).toContain(BOARD_A.id);
    expect(err.message).toContain(BOARD_B.id);
    expect(err.boards.map((b) => b.id)).toEqual([BOARD_A.id, BOARD_B.id]);
    expect(err.message).toContain("--board");
  });

  it("(e) no token and no saved board resolves to null (local mode unchanged)", async () => {
    const deps = makeDeps({ hasToken: false });

    const result = await resolveBoardScope(null, PROJ, deps);

    expect(result).toBeNull();
    // Without a token there is nothing to list — no listing attempt.
    expect(deps.listBoards).not.toHaveBeenCalled();
  });
});
