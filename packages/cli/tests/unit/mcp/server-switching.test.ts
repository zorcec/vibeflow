/**
 * Disposable MCP server switching (ticket 3d613068, open item 1).
 *
 * A local MCP server started, stopped, and restarted against a different
 * board must not carry stale ports/resolution state: every operation takes
 * `projectDir` per call through a stateless shared adapter, so a server
 * bound to board B never resolves board A's records and a restart against
 * A sees A's data with no B residue. Pure reads leave disk bytes untouched.
 */
import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createMcpServer,
  invokeManifestTool,
} from "../../../src/mcp/server.js";
import { manifest } from "../../../src/mcp/manifest.js";

function seedBoard(taskId: string, title: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-switch-"));
  mkdirSync(join(dir, ".vibeflow", "tasks"), { recursive: true });
  writeFileSync(
    join(dir, ".vibeflow", "tasks", `${taskId}.json`),
    JSON.stringify({
      id: taskId,
      title,
      status: "todo",
      selector: "/",
      created: "2026-01-01T00:00:00.000Z",
      comments: [],
      files: [],
    }),
  );
  return dir;
}

function payloadText(
  res: Awaited<ReturnType<typeof invokeManifestTool>>,
): unknown {
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe("disposable MCP switching carries no stale board state", () => {
  it("A -> B -> A: listings and resolution follow the bound board", async () => {
    const idA = "aaaabbbbccccddddeeeeffff00001111";
    const idB = "11112222333344445555666677778888";
    const dirA = seedBoard(idA, "A-task");
    const dirB = seedBoard(idB, "B-task");

    const listTool = manifest.find((t) => t.name === "list_tasks")!;
    const getTool = manifest.find((t) => t.name === "get_task")!;
    const ctxA = { projectDir: dirA, mode: "local" as const };
    const ctxB = { projectDir: dirB, mode: "local" as const };

    // Server 1 bound to A sees only A.
    createMcpServer(dirA, "local");
    const idsA = (
      payloadText(await invokeManifestTool(listTool, ctxA, {})) as {
        tasks: Array<{ id: string }>;
      }
    ).tasks.map((t) => t.id);
    expect(idsA).toContain(idA);
    expect(idsA).not.toContain(idB);

    // Dropped, rebound to B: sees only B; A's id refuses (no leak).
    createMcpServer(dirB, "local");
    const idsB = (
      payloadText(await invokeManifestTool(listTool, ctxB, {})) as {
        tasks: Array<{ id: string }>;
      }
    ).tasks.map((t) => t.id);
    expect(idsB).toContain(idB);
    expect(idsB).not.toContain(idA);
    expect(
      (
        payloadText(await invokeManifestTool(getTool, ctxB, { id: idA })) as {
          ok: boolean;
        }
      ).ok,
    ).toBe(false);

    // Restarted against A: A's data intact, no B residue, disk untouched.
    createMcpServer(dirA, "local");
    const idsA2 = (
      payloadText(await invokeManifestTool(listTool, ctxA, {})) as {
        tasks: Array<{ id: string }>;
      }
    ).tasks.map((t) => t.id);
    expect(idsA2).toContain(idA);
    expect(idsA2).not.toContain(idB);
    expect(
      JSON.parse(
        readFileSync(join(dirA, ".vibeflow", "tasks", `${idA}.json`), "utf8"),
      ).title,
    ).toBe("A-task");
  });
});
