/**
 * Tool catalog + doc-row renderers (ADR: MCP+CLI docs single source of truth).
 *
 * The MCP manifest (`./manifest.ts`) is the source of truth for tool
 * metadata. `toCatalog()` projects it to a JSON-serializable catalog
 * (name/title/description/cliCommand/cliFlags) that ships as the committed
 * `packages/cli/tool-catalog.json`. Dependency-free consumers — the private
 * repo's `scripts/generate-agent-assets.mjs`, the `check-tool-docs` drift
 * guard — read the JSON, never this TS module.
 *
 * `renderMarkdownRows()` / `renderHtmlRows()` produce the doc-table body
 * rows from a catalog, so every surface (README, website table, .md twins,
 * llms.txt) renders the same rows. Descriptions here are the FULL manifest
 * text; surfaces that need one-line cells shorten them at render time.
 */
import type { ToolManifest } from "./manifest.js";

export interface ToolCatalogEntry {
  name: string;
  title: string;
  description: string;
  cliCommand: string;
  cliFlags: string[];
}

export function toCatalog(manifest: readonly ToolManifest[]): ToolCatalogEntry[] {
  return manifest.map((tool) => ({
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description ?? "",
    cliCommand: tool.cliRef.command,
    cliFlags: [...tool.cliRef.flags],
  }));
}

/** First sentence of a description — the one-line cell for doc tables. */
export function shortDescription(description: string): string {
  const first = description.split(/(?<=[.!?])\s/)[0] ?? description;
  return first.replace(/\s+/g, " ").trim();
}

/** Markdown table body rows: `| \`name\` | short desc | \`cli\` + flags |`. */
export function renderMarkdownRows(catalog: readonly ToolCatalogEntry[]): string {
  return catalog
    .map(
      (entry) =>
        `| \`${entry.name}\` | ${shortDescription(entry.description)} | \`${entry.cliCommand}\` ${entry.cliFlags.join(" ")} |`,
    )
    .join("\n");
}

/** HTML `<tbody>` rows matching the website docs-mcp table shape. */
export function renderHtmlRows(catalog: readonly ToolCatalogEntry[]): string {
  return catalog
    .map(
      (entry) =>
        [
          "                <tr>",
          `                  <td><code>${entry.name}</code></td>`,
          `                  <td>${shortDescription(entry.description)}</td>`,
          `                  <td><code>${entry.cliCommand}</code> ${entry.cliFlags.join(" ")}</td>`,
          "                </tr>",
        ].join("\n"),
    )
    .join("\n");
}
