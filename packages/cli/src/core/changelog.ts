import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

/** One `## <version>` section of CHANGELOG.md. */
export interface ChangelogSection {
  version: string;
  /** Raw markdown below the version header (categories, bullets), trimmed. */
  markdown: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Splits CHANGELOG.md content into per-version sections.
 * Version headers are `## <semver>` lines at the start of the line; everything
 * between one header and the next (or EOF) belongs to that version.
 * Returns sections in file order (newest first for changesets output).
 */
export function parseChangelogSections(content: string): ChangelogSection[] {
  const headerRe = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[ \t]*$/gm;
  const matches = [...content.matchAll(headerRe)];
  const sections: ChangelogSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (!match) continue;
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[i + 1];
    const end = next ? next.index ?? content.length : content.length;
    sections.push({
      version: match[1] ?? "",
      markdown: content.slice(start, end).trim(),
    });
  }
  return sections;
}

/** The newest section (first in the file), or null when there are none. */
export function getLatestSection(
  sections: ChangelogSection[],
): ChangelogSection | null {
  return sections[0] ?? null;
}

/** The section matching `version` exactly, or null when absent. */
export function getSectionByVersion(
  sections: ChangelogSection[],
  version: string,
): ChangelogSection | null {
  return sections.find((s) => s.version === version) ?? null;
}

/**
 * Renders one section as terminal text: version + category headers bold,
 * bullet and body lines dim. No trailing newline.
 */
export function formatSectionForTerminal(section: ChangelogSection): string {
  const lines = [`  ${chalk.bold(`What's new in ${section.version}`)}`, ""];
  for (const line of section.markdown.split("\n")) {
    const category = /^### (.+)$/.exec(line);
    if (category) {
      lines.push(`  ${chalk.bold.underline(category[1] ?? "")}`);
    } else {
      lines.push(`  ${chalk.dim(line.trimEnd())}`);
    }
  }
  return lines.join("\n");
}

/**
 * Formats CHANGELOG.md content for the terminal: latest version section by
 * default, every section when `all` is true. Returns "" when nothing parses.
 */
export function changelogText(
  content: string,
  opts: { all?: boolean } = {},
): string {
  const sections = parseChangelogSections(content);
  if (sections.length === 0) return "";
  const shown = opts.all ? sections : sections.slice(0, 1);
  return shown.map((s) => formatSectionForTerminal(s)).join("\n\n");
}

/**
 * Resolves the CHANGELOG.md path candidates relative to a base directory
 * (the CLI is bundled one or two levels below the package root, in dev the
 * module lives in src/core — both resolve via one of these candidates).
 */
export function changelogPathCandidates(baseDir: string): string[] {
  return [
    join(baseDir, "..", "CHANGELOG.md"),
    join(baseDir, "..", "..", "CHANGELOG.md"),
  ];
}

/**
 * Reads the CLI's own CHANGELOG.md. Returns null when missing or unreadable —
 * never throws (same contract as the update check that consumes it).
 */
export function readChangelogContent(baseDir = MODULE_DIR): string | null {
  try {
    for (const candidate of changelogPathCandidates(baseDir)) {
      if (existsSync(candidate)) {
        return readFileSync(candidate, "utf8");
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** JSON payload served by GET /api/changelog. */
export interface ChangelogResponse {
  /** Version of the newest changelog entry, or null when none parsed. */
  version: string | null;
  sections: ChangelogSection[];
}

/** Builds the /api/changelog response from raw content (null = unreadable). */
export function buildChangelogResponse(
  content: string | null,
): ChangelogResponse {
  const sections = parseChangelogSections(content ?? "");
  return { version: getLatestSection(sections)?.version ?? null, sections };
}
