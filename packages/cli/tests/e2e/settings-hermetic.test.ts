/**
 * Regression test for bug 072d6a8a: e2e temp project stores must be
 * hermetic — the owner-global `~/.vibeflow/settings.json` (on this box:
 * `{"autoCommit": true, "panelWidth": 400}`) must not change their
 * behaviour.
 *
 * Two assertions, same defect from two sides:
 *
 * 1. The harness precondition: the worker's effective global settings are
 *    empty (the e2e setup points HOME at a clean temp dir). Without the
 *    `hermetic-home.ts` setup entry this reads the operator's real file.
 * 2. The behaviour it protects: moving a temp-store task to review with a
 *    comment but no commit message succeeds. With a leaked
 *    `autoCommit: true` the review gate refuses with COMMIT_MESSAGE_REQUIRED.
 *
 * Non-vacuity was proven on a box carrying a global `autoCommit: true`:
 * with the setup entry removed both tests fail (global reads
 * `{autoCommit: true, panelWidth: 400}`, the transition is refused); with
 * it present both pass.
 *
 * Product behaviour is deliberately NOT changed here: `loadSettings()`
 * still merges global settings for real projects (pinned by
 * `tests/unit/settings.test.ts`), and per-test local settings files keep
 * working — only the e2e worker's HOME is isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readGlobalSettings } from "../../src/core/settings.js";
import {
  bootMcpServer,
  newClient,
  initialize,
  callTool,
  assertJsonTextContent,
  seedGitUser,
  type McpClient,
  type McpTestEnv,
} from "./mcp-helpers.js";

describe("e2e settings hermeticity (072d6a8a)", () => {
  let env: McpTestEnv;
  let client: McpClient;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "settings-hermetic-"));
    seedGitUser(tmp);
    env = await bootMcpServer(tmp);
    client = newClient(env.mcpUrl);
    await initialize(client);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("worker global settings are empty — the operator's ~/.vibeflow/settings.json does not leak in", () => {
    // On a non-hermetic worker this is the operator's real file, e.g.
    // { autoCommit: true, panelWidth: 400 }.
    expect(readGlobalSettings()).toEqual({});
  });

  it("temp store ignores owner-global autoCommit: review + comment without commitMessage succeeds", async () => {
    const task = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "hermetic gate" }),
    );
    const res = await callTool(client, "update_task", {
      id: task.id,
      status: "review",
      comment: "what changed and why",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = JSON.parse(body.result.content[0].text);
    // A leaked autoCommit:true refuses here with { error: { code:
    // "COMMIT_MESSAGE_REQUIRED" } } — a success payload has no error envelope.
    expect(parsed.error).toBeUndefined();
    expect(parsed.status).toBe("review");
  });
});
