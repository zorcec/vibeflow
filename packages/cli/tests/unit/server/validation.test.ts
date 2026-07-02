import { describe, it, expect } from "vitest";
import { isValidTaskId, isSafeAgentArg } from "../../../src/server/server.js";

describe("isValidTaskId", () => {
  it("accepts a 30-character hex string", () => {
    expect(isValidTaskId("a".repeat(30))).toBe(true);
    expect(isValidTaskId("0123456789abcdef".repeat(2).slice(0, 30))).toBe(true);
  });

  it("rejects non-hex characters", () => {
    expect(isValidTaskId("g".repeat(30))).toBe(false);
    expect(isValidTaskId("../etc/passwd")).toBe(false);
  });

  it("rejects wrong lengths", () => {
    expect(isValidTaskId("a".repeat(29))).toBe(false);
    expect(isValidTaskId("a".repeat(31))).toBe(false);
  });
});

describe("isSafeAgentArg", () => {
  it("accepts typical model and agent identifiers", () => {
    expect(isSafeAgentArg("claude-sonnet-4-5")).toBe(true);
    expect(isSafeAgentArg("openai/gpt-4o")).toBe(true);
    expect(isSafeAgentArg("my_agent.v2")).toBe(true);
  });

  it("rejects values that could be interpreted as CLI options", () => {
    expect(isSafeAgentArg("--dangerously-skip-permissions")).toBe(false);
    expect(isSafeAgentArg("-m")).toBe(false);
  });

  it("rejects shell metacharacters and whitespace", () => {
    expect(isSafeAgentArg("model; rm -rf /")).toBe(false);
    expect(isSafeAgentArg("model name")).toBe(false);
    expect(isSafeAgentArg("model&name")).toBe(false);
  });

  it("rejects empty or overly long values", () => {
    expect(isSafeAgentArg("")).toBe(false);
    expect(isSafeAgentArg("a".repeat(81))).toBe(false);
  });
});
