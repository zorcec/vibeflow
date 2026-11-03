/**
 * Tool-catalog drift guard (ticket 6179fadc — MCP+CLI docs single source).
 *
 * - Committed `packages/cli/tool-catalog.json` must equal `toCatalog(manifest)`.
 *   Regenerate with `UPDATE_TOOL_CATALOG=1` and commit the JSON.
 * - Fixture tests pin the row renderers (`renderMarkdownRows`,
 *   `renderHtmlRows`) so generated doc tables keep a stable shape.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../../../src/mcp/manifest.js";
import {
  toCatalog,
  renderMarkdownRows,
  renderHtmlRows,
  type ToolCatalogEntry,
} from "../../../src/mcp/tool-docs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dirname, "../../../tool-catalog.json");

const FIXTURE: ToolCatalogEntry[] = [
  {
    name: "list_tasks",
    title: "List tasks",
    description: "List tasks with optional filters. Roots only unless children.",
    cliCommand: "tasks",
    cliFlags: ["--status", "--limit"],
  },
  {
    name: "get_task",
    title: "Get task",
    description: "Get a single task by ID. Read-only.",
    cliCommand: "tasks",
    cliFlags: ["--get"],
  },
];

describe("tool catalog", () => {
  it("committed tool-catalog.json matches the live manifest", () => {
    const live = toCatalog(manifest);
    if (process.env.UPDATE_TOOL_CATALOG === "1") {
      writeFileSync(CATALOG_PATH, JSON.stringify(live, null, 2) + "\n");
      return;
    }
    const committed = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    expect(committed).toEqual(live);
  });

  it("manifest has no duplicate tool names", () => {
    const names = manifest.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("tool row renderers (fixture)", () => {
  it("renders markdown rows from a fixture catalog", () => {
    expect(renderMarkdownRows(FIXTURE)).toBe(
      [
        "| `list_tasks` | List tasks with optional filters. | `tasks` --status --limit |",
        "| `get_task` | Get a single task by ID. | `tasks` --get |",
      ].join("\n"),
    );
  });

  it("renders HTML rows from a fixture catalog", () => {
    expect(renderHtmlRows(FIXTURE)).toBe(
      [
        "                <tr>",
        "                  <td><code>list_tasks</code></td>",
        "                  <td>List tasks with optional filters.</td>",
        "                  <td><code>tasks</code> --status --limit</td>",
        "                </tr>",
        "                <tr>",
        "                  <td><code>get_task</code></td>",
        "                  <td>Get a single task by ID.</td>",
        "                  <td><code>tasks</code> --get</td>",
        "                </tr>",
      ].join("\n"),
    );
  });
});
