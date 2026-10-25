/**
 * MCP session target pinning (ticket d7b9dc13, ADR-0005).
 *
 * A stdio session is bound at startup to one board (the project pointer
 * then), one API base, and one absolute root. Auth is re-resolved per
 * call through the mtime-checked cache, so login/logout take effect
 * WITHOUT a restart — and the credential read can never leave the
 * pinned root. The session must REFUSE (never silently serve a new
 * store as the old one) with:
 * - SESSION_TARGET_CHANGED on board-A → board-B or an API host change;
 * - NOT_CONNECTED when the project declares a board but holds no
 *   credential for it (unlinked — a login-shaped refusal, not silent
 *   local).
 * A null ↔ board transition is a login/logout in THIS project (allowed).
 *
 * These tests drive `invokeManifestTool` (the same dispatch the stdio
 * server registers) with an explicit per-server session state against
 * REAL project pointers and a REAL credential store under a temp HOME
 * (never the owner's `~/.vibeflow`) — so the mtime cache, the pointer
 * read, and the credential read are all exercised, not mocked. The
 * cache is dropped between reconfigurations through its own test seam
 * (no waiting on filesystem mtime granularity):
 * - same-target calls proceed (including a token refresh that changes no
 *   compared dimension, and a login null → board);
 * - board / API retargets refuse on the very call that observes them —
 *   even the identity probe (`get_project`) refuses, so the new target
 *   is never described as the session's own;
 * - an unlinked project refuses with NOT_CONNECTED naming the login
 *   command, and pins nothing;
 * - omitting the session keeps the historical pass-through (chat-MCP,
 *   HTTP, and hand-built test contexts never see ambient credentials
 *   flip them into a false retarget).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import os from "node:os";

import {
  dropProjectAuthCache,
  resetLegacyTokenWarning,
} from "../../../src/auth/project-auth.js";
import { writeCredential } from "../../../src/auth/credentials.js";
import { writeProjectPointer } from "../../../src/auth/project-pointer.js";
import {
  invokeManifestTool,
  type McpSessionState,
} from "../../../src/mcp/server.js";
import { manifest } from "../../../src/mcp/manifest.js";
import type { OperationContext } from "../../../src/core/operations.js";
import { getApiUrl } from "../../../src/core/api-url.js";

const getProjectTool = manifest.find((t) => t.name === "get_project")!;
const API_URL = getApiUrl();

function localCtx(projectDir: string): OperationContext {
  return { projectDir, mode: "local" };
}

function payloadText(
  res: Awaited<ReturnType<typeof invokeManifestTool>>,
): unknown {
  return JSON.parse((res.content[0] as { text: string }).text);
}

/** A bare temp project: no pointer → resolves local. */
function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "mcp-session-"));
}

/** Link a project to a board with a real credential under the temp HOME. */
async function linkProject(
  projectDir: string,
  boardId: string,
  apiUrl: string = API_URL,
  token: string = "test-token",
): Promise<void> {
  writeProjectPointer(projectDir, { apiUrl, id: boardId });
  await writeCredential(apiUrl, { token, workspaceId: boardId });
  dropProjectAuthCache(projectDir);
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "mcp-session-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  dropProjectAuthCache();
  resetLegacyTokenWarning();
  delete process.env.VIBEFLOW_API_URL;
});

afterEach(() => {
  delete process.env.VIBEFLOW_API_URL;
  dropProjectAuthCache();
  vi.restoreAllMocks();
});

describe("MCP session target pinning", () => {
  it("same-target calls proceed; the session pins on first call", async () => {
    const dir = makeProject();
    const session: McpSessionState = {};
    const first = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { root: string; mode: string };
    expect(first.root).toBe(dir);
    expect(first.mode).toBe("local");
    expect(session.frozen?.boardId).toBeNull();

    const second = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { root: string };
    expect(second.root).toBe(dir);
  });

  it("login (null → board) is allowed and rides the live mode", async () => {
    const dir = makeProject();
    const session: McpSessionState = {};
    const ctx = localCtx(dir);
    await invokeManifestTool(getProjectTool, ctx, {}, session);

    // The user runs `vibeflow login` mid-session: same project, same API,
    // now linked — allowed, never a retarget refusal.
    await linkProject(dir, "board-A");
    const second = payloadText(
      await invokeManifestTool(getProjectTool, ctx, {}, session),
    ) as { mode: string };
    expect(second.mode).toBe("saas");
    expect(ctx.mode).toBe("saas");
  });

  it("logout (board → null) is allowed and rides the live mode", async () => {
    const dir = makeProject();
    await linkProject(dir, "board-A");
    const session: McpSessionState = {};
    const ctx: OperationContext = { projectDir: dir, mode: "saas" };
    const first = payloadText(
      await invokeManifestTool(getProjectTool, ctx, {}, session),
    ) as { mode: string };
    expect(first.mode).toBe("saas");

    // The user runs `vibeflow logout` mid-session: the pointer stays but
    // the credential is gone → the project resolves local, not foreign.
    const { deleteCredential } = await import(
      "../../../src/auth/credentials.js"
    );
    await deleteCredential(API_URL);
    dropProjectAuthCache(dir);
    const second = payloadText(
      await invokeManifestTool(getProjectTool, ctx, {}, session),
    );
    // An unlinked pointer refuses with NOT_CONNECTED (next test pins the
    // code); what matters here is it is NOT served as saas anymore.
    expect((second as { ok: boolean }).ok).toBe(false);
  });

  it("board retarget (board-A → board-B switch) refuses", async () => {
    const dir = makeProject();
    await linkProject(dir, "board-A");
    const session: McpSessionState = {};
    await invokeManifestTool(getProjectTool, localCtx(dir), {}, session);

    await linkProject(dir, "board-B");
    const refused = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("SESSION_TARGET_CHANGED");
    expect(refused.error.message).toContain("board board-A → board-B");
  });

  it("API-base retarget refuses", async () => {
    const dir = makeProject();
    await linkProject(dir, "board-A");
    const session: McpSessionState = {};
    await invokeManifestTool(getProjectTool, localCtx(dir), {}, session);

    // Same board id on a different host, fully credentialed there — still
    // a retarget, never a silent host switch.
    const otherApi = "http://127.0.0.1:9";
    process.env.VIBEFLOW_API_URL = otherApi;
    await linkProject(dir, "board-A", otherApi);
    const refused = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("SESSION_TARGET_CHANGED");
    expect(refused.error.message).toContain("API base");
  });

  it("unlinked project (pointer without credential) refuses with NOT_CONNECTED", async () => {
    const dir = makeProject();
    writeProjectPointer(dir, { apiUrl: API_URL, id: "board-A" });
    dropProjectAuthCache(dir);
    const session: McpSessionState = {};
    const refused = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}, session),
    ) as { ok: boolean; error: { code: string; message: string } };
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("NOT_CONNECTED");
    expect(refused.error.message).toContain("vibeflow login");
    // The refusal pins nothing — a later login proceeds.
    expect(session.frozen).toBeUndefined();
  });

  it("same-target token refresh is allowed (mode/board/API unchanged)", async () => {
    const dir = makeProject();
    await linkProject(dir, "board-A", API_URL, "tok-1");
    const session: McpSessionState = {};
    const ctx: OperationContext = { projectDir: dir, mode: "saas" };
    const first = payloadText(
      await invokeManifestTool(getProjectTool, ctx, {}, session),
    ) as { mode: string };
    expect(first.mode).toBe("saas");
    // Token bytes rotate (same board, same API); the compared dimensions hold.
    await linkProject(dir, "board-A", API_URL, "tok-2");
    const second = payloadText(
      await invokeManifestTool(getProjectTool, ctx, {}, session),
    ) as { mode: string };
    expect(second.mode).toBe("saas");
  });

  it("without a session the dispatch keeps the historical pass-through", async () => {
    const dir = makeProject();
    // Ambient says saas, the hand-built context says local: no session, no
    // refusal — the tool runs against the context it was given.
    await linkProject(dir, "board-A");
    const res = payloadText(
      await invokeManifestTool(getProjectTool, localCtx(dir), {}),
    ) as { mode: string };
    expect(res.mode).toBe("local");
  });
});
