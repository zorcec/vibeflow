/**
 * Glob probe (design-system P4, verification only — not exported).
 * Uses mapped utilities that appear in NO file under src/kanban/ or the
 * CLI client, so the class reaching dist/client/kanban.css proves the
 * widened Tailwind content glob scans src/primitives/.
 */
export function GlobProbe() {
  return <div className="bg-surface text-text-muted border-border">probe</div>;
}
