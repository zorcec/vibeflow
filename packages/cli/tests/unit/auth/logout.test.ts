import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../src/auth/token.js", () => ({
  deleteToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/auth/workspace.js", () => ({
  deleteWorkspace: vi.fn().mockResolvedValue(undefined),
}));

import { logout } from "../../../src/auth/logout.js";
import { deleteToken } from "../../../src/auth/token.js";
import { deleteWorkspace } from "../../../src/auth/workspace.js";

afterEach(() => vi.clearAllMocks());

describe("logout", () => {
  it("calls deleteToken and deleteWorkspace", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await logout();
    expect(deleteToken).toHaveBeenCalledOnce();
    expect(deleteWorkspace).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("logs a success message containing 'Logged out'", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await logout();
    const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toMatch(/Logged out/i);
    consoleSpy.mockRestore();
  });
});
