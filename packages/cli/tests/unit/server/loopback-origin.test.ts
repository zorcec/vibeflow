import { describe, it, expect } from "vitest";
import { isLoopbackOrigin } from "../../../src/core/loopback.js";

describe("isLoopbackOrigin", () => {
  it.each([
    ["http://localhost:3700", true],
    ["http://localhost:3000", true],
    ["https://localhost:3700", true],
    ["http://127.0.0.1:8000", true],
    ["http://[::1]:3700", true],
    ["http://localhost.attacker.com", false],
    ["http://localhost.attacker.com:3700", false],
    ["https://evil.com", false],
    ["javascript:alert(1)", false],
    ["http://192.168.1.1:3700", false],
  ])("isLoopbackOrigin(%s) === %s", (origin, expected) => {
    expect(isLoopbackOrigin(origin)).toBe(expected);
  });
});
