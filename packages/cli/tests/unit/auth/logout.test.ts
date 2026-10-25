import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../src/auth/credentials.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/auth/credentials.js")
  >();
  return { ...actual, deleteCredential: vi.fn() };
});

vi.mock("../../../src/auth/project-pointer.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/auth/project-pointer.js")
  >();
  return {
    ...actual,
    readProjectPointer: vi.fn(),
    deleteProjectPointer: vi.fn(),
  };
});

import { logout } from "../../../src/auth/logout.js";
import { deleteCredential } from "../../../src/auth/credentials.js";
import {
  readProjectPointer,
  deleteProjectPointer,
} from "../../../src/auth/project-pointer.js";

afterEach(() => vi.clearAllMocks());

const POINTER = { apiUrl: "https://app.vibeflow.tools", id: "board-1" };

describe("logout", () => {
  it("deletes only the current project's credential and stays linked", async () => {
    vi.mocked(readProjectPointer).mockReturnValue(POINTER);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await logout("/test-project");
    expect(deleteCredential).toHaveBeenCalledTimes(1);
    expect(deleteCredential).toHaveBeenCalledWith(POINTER.apiUrl);
    // The repo pointer stays by default — the project is still "linked",
    // just without a credential.
    expect(deleteProjectPointer).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("removes the pointer too with --unlink", async () => {
    vi.mocked(readProjectPointer).mockReturnValue(POINTER);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await logout("/test-project", { unlink: true });
    expect(deleteCredential).toHaveBeenCalledWith(POINTER.apiUrl);
    expect(deleteProjectPointer).toHaveBeenCalledWith("/test-project");
    consoleSpy.mockRestore();
  });

  it("does nothing but explain when the project is not linked", async () => {
    vi.mocked(readProjectPointer).mockReturnValue(null);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await logout("/test-project");
    expect(deleteCredential).not.toHaveBeenCalled();
    expect(deleteProjectPointer).not.toHaveBeenCalled();
    const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toMatch(/not linked/i);
    consoleSpy.mockRestore();
  });

  it("logs a success message containing 'Logged out'", async () => {
    vi.mocked(readProjectPointer).mockReturnValue(POINTER);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await logout("/test-project");
    const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toMatch(/Logged out/i);
    consoleSpy.mockRestore();
  });
});
