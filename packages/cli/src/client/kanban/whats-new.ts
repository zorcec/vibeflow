/**
 * Pure logic for the kanban "What's New" changelog modal.
 * Kept DOM-free (aside from guarded localStorage/fetch access) so it can be
 * unit-tested in the node vitest environment.
 */

/** One version section as returned by GET /api/changelog. */
export interface ChangelogSection {
  version: string;
  markdown: string;
}

/** localStorage key holding the last changelog version the user has seen. */
export const LAST_SEEN_VERSION_KEY = "vibeflow-last-seen-version";

/**
 * Returns true when `a` is strictly newer than `b` (numeric semver compare).
 * Mirrors the CLI's update-check comparison; prerelease suffixes are ignored.
 */
export function isVersionNewer(a: string, b: string): boolean {
  const parts = (v: string) =>
    v
      .replace(/[^0-9.]/g, "")
      .split(".")
      .map(Number);
  const [aa = 0, ab = 0, ac = 0] = parts(a);
  const [ba = 0, bb = 0, bc = 0] = parts(b);
  if (aa !== ba) return aa > ba;
  if (ab !== bb) return ab > bb;
  return ac > bc;
}

/**
 * Decides whether the What's New modal should open after a load.
 * Shows only when the running CLI version is strictly newer than the last
 * version the user acknowledged. First visits (no stored version) do not show.
 */
export function shouldShowWhatsNew(
  storedVersion: string | null,
  currentVersion: string,
): boolean {
  if (!currentVersion || !storedVersion) return false;
  return isVersionNewer(currentVersion, storedVersion);
}

/** Reads the stored last-seen version; null when unavailable. */
export function readStoredVersion(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_VERSION_KEY);
  } catch {
    return null;
  }
}

/** Marks the given version as seen (called when the modal is dismissed). */
export function markVersionSeen(version: string): void {
  try {
    localStorage.setItem(LAST_SEEN_VERSION_KEY, version);
  } catch {
    /* ignore — private mode / disabled storage */
  }
}

/** Picks the section for `version`, falling back to the first (latest) one. */
export function pickWhatsNewSection(
  sections: ChangelogSection[],
  version: string,
): ChangelogSection | null {
  const exact = sections.find((s) => s.version === version);
  return exact ?? sections[0] ?? null;
}

/** Markdown for the single "what's new" section (version header included). */
export function whatsNewMarkdown(section: ChangelogSection | null): string {
  if (!section) return "";
  return `## ${section.version}\n\n${section.markdown}`;
}

/** Markdown for the full changelog, newest first. */
export function fullChangelogMarkdown(
  sections: ChangelogSection[],
): string {
  return sections.map((s) => whatsNewMarkdown(s)).join("\n\n");
}

/** Fetches changelog sections from the server; empty array on any failure. */
export async function fetchChangelogSections(): Promise<ChangelogSection[]> {
  try {
    const r = await fetch(
      `${window.location.origin}/api/changelog?_=${Date.now()}`,
      { cache: "no-store" },
    );
    if (!r.ok) return [];
    const data = (await r.json()) as { sections?: ChangelogSection[] };
    return Array.isArray(data.sections) ? data.sections : [];
  } catch {
    return [];
  }
}
