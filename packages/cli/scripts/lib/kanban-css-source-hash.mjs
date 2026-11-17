/**
 * Fingerprint of every file `gen-kanban-css.mjs` inlines into the CLI board's
 * stylesheet.
 *
 * WHY THIS EXISTS: the generated `src/server/kanban-css.gen.ts` is committed,
 * and the build regenerates it — but until now nothing FAILED when someone
 * edited the shared UI CSS and committed without rebuilding. The CLI board then
 * served the previous stylesheet while the hosted app served the new one, and no
 * test noticed (found while reviewing the phone-width work, ticket 45a8e57c).
 *
 * The generator writes this hash next to the CSS; a unit test recomputes it from
 * the same sources and fails on any difference. Hashing the INPUTS rather than
 * the minified output keeps the check independent of the Tailwind version's
 * output formatting.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every file whose content reaches the generated stylesheet, in build order. */
export const KANBAN_CSS_SOURCES = [
  resolve(root, "src/client/kanban/kanban.css"),
  resolve(root, "../../packages/ui/src/kanban/themes.css"),
  resolve(root, "../../packages/ui/src/primitives/theme.css"),
  resolve(root, "../../packages/ui/src/kanban/kanban.css"),
];

export function kanbanCssSourceHash() {
  const hash = createHash("sha256");
  for (const file of KANBAN_CSS_SOURCES) {
    hash.update(file.split("/packages/").pop() ?? file);
    hash.update("\0");
    hash.update(readFileSync(file, "utf-8"));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}
