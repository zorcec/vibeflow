/**
 * Sort-key hardening on the create surface (core/operations + MCP CreateTaskInput).
 *
 * Every created task must carry a well-formed sortKey even when the caller
 * omits it; an explicitly supplied sortKey must survive untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  CreateTaskInput,
  type OperationContext,
} from "../../src/core/operations.js";

let projectDir: string;

function ctx(): OperationContext {
  return { projectDir, mode: "local", userId: "Agent Smith" };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "sortkey-ops-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("CreateTaskInput sortKey", () => {
  it("accepts input without sortKey", () => {
    const parsed = CreateTaskInput.parse({ title: "No key" });
    expect(parsed.sortKey).toBeUndefined();
  });

  it("accepts an optional sortKey", () => {
    const parsed = CreateTaskInput.parse({
      title: "With key",
      sortKey: "0000000000000042",
    });
    expect(parsed.sortKey).toBe("0000000000000042");
  });
});

describe("createTask sortKey", () => {
  it("auto-assigns a well-formed key when omitted", async () => {
    const result = await createTask(ctx(), { title: "Auto key", description: "" });

    expect(result.ok).toBe(true);
    expect(result.data?.sortKey).toMatch(/^\d{16}$/);
  });

  it("preserves an explicitly supplied key", async () => {
    const supplied = "0000000000000042";
    const result = await createTask(ctx(), {
      title: "Explicit key",
      description: "",
      sortKey: supplied,
    });

    expect(result.data?.sortKey).toBe(supplied);
  });
});
