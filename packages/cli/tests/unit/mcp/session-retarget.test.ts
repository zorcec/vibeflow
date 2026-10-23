/**
 * MCP session retarget refusal (ticket d7b9dc13, plan step 7).
 *
 * A stdio session is bound at startup to one backend (mode), one board
 * (saved workspace selection), one API base, and one absolute root. When
 * the live configuration no longer matches the pinned target — login/logout
 * mid-session (local↔saas), a workspace switch, an API host change — the
 * session must REFUSE with SESSION_TARGET_CHANGED instead of silently
 * serving the new store as the old one.
 *
 * These tests drive `invokeManifestTool` (the same dispatch the stdio server
 * registers) with an explicit per-server session state, mocking credentials
 * and workspace selection per call:
 * - same-target calls proceed (including a token refresh that changes no
 *   compared dimension);
 * - backend / board / API retargets refuse on the very call that observes
 *   them — even the identity probe (`get_project`) refuses, so the new
 *   target is never described as the session's own;
 * - omitting the session keeps the historical pass-through (chat-MCP, HTTP,
 *   and hand-built test contexts never see ambient credentials flip them
 *   into a false retarget);
 * - the pinned mode is the bound context's, not the live one: an
 *   implementation that silently rebuilds the target from the live config
 *   adopts saas on the flip call and fails the refusal assertion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../../src/auth/mode.js", () => ({
  getMode: vi.fn(),
}));
vi.mock("../../../src/auth/workspace.js", () => ({
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

import { getMode } from "../../../src/auth/mode.js";
import { readWorkspace } from "../../../src/auth/workspace.js";
import {
  invokeManifestTool,
  type McpSessionState,
} from "../../../src/mcp/server.js";
import { manifest } from "../../../src/mcp/manifest.js";
import type { OperationContext } from "../../../src/core/operations.js";

const getProjectTool = manifest.find((t) => t.name === "get_project")!;

function localCtx(projectDir: string): OperationContext {
  return { projectDir, mode: "local" };
}

function payloadText(
  res: Awaited<ReturnType<typeof invokeManifestTool>>,
): unknown {
  return JSON.parse((res.content[0] as { text: string }).text);
}

beforeEach(() => {
  vi.mocked(getMode).mockResolvedValue("local");
  vi.mocked(readWorkspace).mockResolvedValue(null);
  delete process.env.VIBEFLOW_API_URL;
});

afterEach(() => {
  delete process.env.VIBEFLOW_API_URL;
  vi.clearAllMocks();
});

describe("MCP session target pinning", () => {
  it("same-target calls proceed; the session pins on first call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-session-"));
    const session: McpSessionState = {};
    const first = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { root: string; mode: string };
    expect(first.root).toBe(dir);
    expect(first.mode).toBe("local");
    expect(session.frozen?.mode).toBe("local");

    const second = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { root: string };
    expect(second.root).toBe(dir);
  });

  it("backend retarget (local → saas) refuses, even for get_project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-session-"));
    const session: McpSessionState = {};
    await invokeManifestTool(getProjectTool, localCtx(dir), {}, session);

    vi.mocked(getMode).mockResolvedValue("saas");
    const refused = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("SESSION_TARGET_CHANGED");
    expect(refused.error.message).toContain("backend local → saas");
  });

  it("a retarget before the first call refuses on that first call (no silent adoption)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-session-"));
    const session: McpSessionState = {};
    // The bound session is local, but the live config already flipped.
    vi.mocked(getMode).mockResolvedValue("saas");
    const refused = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { ok: boolean; error: { code: string } };
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("SESSION_TARGET_CHANGED");
  });

  it("board retarget (saved workspace switch) refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-session-"));
    const session: McpSessionState = {};
    await invokeManifestTool(getProjectTool, localCtx(dir), {}, session);

    vi.mocked(readWorkspace).mockResolvedValue({
      id: "board-2",
      name: "B2",
      url: "https://app.vibeflow.tools",
    });
    const refused = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("SESSION_TARGET_CHANGED");
    expect(refused.error.message).toContain("board (none) → board-2");
  });

  it("API-base retarget refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-session-"));
    const session: McpSessionState = {};
    await invokeManifestTool(getProjectTool, localCtx(dir), {}, session);

    process.env.VIBEFLOW_API_URL = "http://127.0.0.1:9";
    const refused = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("SESSION_TARGET_CHANGED");
    expect(refused.error.message).toContain("API base");
  });

  it("same-target token refresh is allowed (mode/board/API unchanged)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-session-"));
    const session: McpSessionState = {};
    const ctx: OperationContext = { projectDir: dir, mode: "saas" };
    vi.mocked(getMode).mockResolvedValue("saas");
    const first = payloadText(
      await invokeManifestTool(getProjectTool, ctx, {}, session),
    ) as { mode: string };
    expect(first.mode).toBe("saas");
    // Token bytes rotate (unobservable here); the compared dimensions hold.
    const second = payloadText(
      await invokeManifestTool(getProjectTool, ctx, {}, session),
    ) as { mode: string };
    expect(second.mode).toBe("saas");
  });

  it("without a session the dispatch keeps the historical pass-through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-session-"));
    // Ambient says saas, the hand-built context says local: no session, no
    // refusal — the tool runs against the context it was given.
    vi.mocked(getMode).mockResolvedValue("saas");
    const res = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}),
    ) as { mode: string };
    expect(res.mode).toBe("local");
  });
});
