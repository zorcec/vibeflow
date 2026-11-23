import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/auth/project-auth.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/auth/project-auth.js")
  >();
  return { ...actual, resolveProjectAuth: vi.fn() };
});

import { resolveProjectAuth } from "../../../src/auth/project-auth.js";
import {
  saasAuth,
  localAuth,
  unlinkedAuth,
} from "../helpers/mock-project-auth.js";

const PROJ = "/test-project";

describe("CLI auth/mode", () => {
  it("returns 'local' when the project has no pointer (local auth)", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(localAuth());
    const { getMode } = await import("../../../src/auth/mode.js");
    expect(await getMode(PROJ)).toBe("local");
  });

  it("returns 'saas' when the project resolves to a linked credential", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
    const { getMode } = await import("../../../src/auth/mode.js");
    expect(await getMode(PROJ)).toBe("saas");
  });

  it("returns 'local' for an unlinked project (pointer without credential)", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(
      localAuth({ unlinked: true, workspaceId: "board-1" }),
    );
    const { getMode } = await import("../../../src/auth/mode.js");
    expect(await getMode(PROJ)).toBe("local");
  });
});

/**
 * The invocation-level authority (ticket 73cb9048): `getMode()` folds a
 * REFUSED link into "local", and a command that trusted the mode alone wrote
 * to the local store while the project declared itself online. ADR-0005: "a
 * pointer without a credential refuses, never silent local".
 */
describe("CLI auth/mode — command access", () => {
  it("grants local mode for a project with no pointer", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(localAuth());
    const { resolveCommandAccess } = await import("../../../src/auth/mode.js");
    expect(await resolveCommandAccess(PROJ)).toEqual({
      ok: true,
      mode: "local",
      projectDir: PROJ,
    });
  });

  it("grants saas mode for a linked project with a usable credential", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
    const { resolveCommandAccess } = await import("../../../src/auth/mode.js");
    expect(await resolveCommandAccess(PROJ)).toEqual({
      ok: true,
      mode: "saas",
      projectDir: PROJ,
    });
  });

  it("refuses an unlinked project with NOT_CONNECTED, naming the login remedy", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(unlinkedAuth());
    const { resolveCommandAccess } = await import("../../../src/auth/mode.js");
    const access = await resolveCommandAccess(PROJ);
    expect(access.ok).toBe(false);
    if (access.ok) return;
    expect(access.code).toBe("NOT_CONNECTED");
    // The resolver's own sentence (board + cause) is the message, verbatim.
    expect(access.message).toBe(
      "This project is linked to board board-1 but has no credential.",
    );
    expect(access.suggestion).toContain("vibeflow login");
    expect(access.suggestion).toContain("auth logout --unlink");
  });

  it("falls back to naming the board when the resolver gives no notice", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(
      unlinkedAuth({ notice: null }),
    );
    const { resolveCommandAccess } = await import("../../../src/auth/mode.js");
    const access = await resolveCommandAccess(PROJ);
    expect(access.ok).toBe(false);
    if (access.ok) return;
    expect(access.message).toContain("board-1");
    expect(access.message).toContain("vibeflow login");
  });
});
