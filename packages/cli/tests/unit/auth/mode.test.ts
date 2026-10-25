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
