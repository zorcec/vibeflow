import { describe, it, expect, vi } from "vitest";
import * as tokenModule from "../../../src/auth/token";

vi.mock("../../../src/auth/token");

describe("CLI auth/mode", () => {
  it("returns 'local' when no token file exists", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const { getMode } = await import("../../../src/auth/mode");
    expect(await getMode()).toBe("local");
  });

  it("returns 'saas' when token file contains a value", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("tok_abc123");
    const { getMode } = await import("../../../src/auth/mode");
    expect(await getMode()).toBe("saas");
  });

  it("returns 'local' when token is empty string", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const { getMode } = await import("../../../src/auth/mode");
    expect(await getMode()).toBe("local");
  });
});
