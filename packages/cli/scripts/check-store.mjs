// Task store integrity check (ticket 8538344b).
//
// Walks <projectRoot>/.vibeflow/tasks (date subdirectories plus the flat
// layout) and fails on any task file with a parse error or an unresolved
// git conflict marker (a line starting with <<<<<<<, =======, or >>>>>>>).
// Prints every offending path and exits 1; exits 0 when clean.
//
// Dependency-free on purpose: it runs as `pnpm check:store` and inside the
// pre-commit hook without a build. The marker patterns mirror
// src/core/task-store-check.ts (importable, unit-tested) — keep them in sync.
//
// Usage: node scripts/check-store.mjs [projectRoot]   (default: cwd)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const MARKER_RE = /^(<{7}|={7}|>{7})/m;

function isTaskJsonFile(name) {
  return name.endsWith(".json") && !name.endsWith(".auth.json");
}

function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) collect(abs, out);
    else if (entry.isFile() && isTaskJsonFile(entry.name)) out.push(abs);
  }
}

function checkText(text) {
  const marker = MARKER_RE.exec(text);
  if (marker) {
    const line = text.slice(0, marker.index).split("\n").length;
    return `git conflict marker on line ${line} (${marker[0].slice(0, 7)}...): resolve the merge before committing`;
  }
  try {
    JSON.parse(text);
  } catch (err) {
    return `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

const root = resolve(process.argv[2] ?? process.cwd());
const tasksDir = join(root, ".vibeflow", "tasks");
if (!existsSync(tasksDir)) {
  console.log(`No task store at ${tasksDir} — nothing to check.`);
  process.exit(0);
}

const files = [];
collect(tasksDir, files);
files.sort();

const offenders = [];
for (const filePath of files) {
  let text;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (err) {
    offenders.push(`  X ${filePath}: unreadable: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  const reason = checkText(text);
  if (reason !== null) offenders.push(`  X ${filePath}: ${reason}`);
}

if (offenders.length > 0) {
  console.error(`Store check FAILED: ${offenders.length} offending file(s) of ${files.length} checked.`);
  console.error(`Never 'git add -A' a synced store with an unresolved merge — resolve, pull, verify, then add.`);
  for (const line of offenders) console.error(line);
  process.exit(1);
}
console.log(`Store check passed: ${files.length} task file(s), no conflict markers or parse errors.`);
