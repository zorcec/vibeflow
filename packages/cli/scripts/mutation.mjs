#!/usr/bin/env node
/**
 * Incremental mutation runner — only mutates files changed since last commit.
 *
 * Usage:
 *   node scripts/mutation.mjs           # changed files vs HEAD~1
 *   node scripts/mutation.mjs --base HEAD~3  # changed files vs HEAD~3
 *   node scripts/mutation.mjs --all     # full mutation (all files)
 *
 * Behaviour:
 *   - Detects which source files changed vs the base ref
 *   - If changed files found: runs stryker with --mutate scoped to those files
 *     using stryker.changes.config.mjs (disables vitest.related so test
 *     discovery doesn't fail for files only tested through Playwright)
 *   - Falls back to full `stryker run` if no source files changed or --all
 */
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const pkgName = JSON.parse(
  execSync('cat package.json', { cwd: pkgRoot, encoding: 'utf8' })
).name;

// Find the git monorepo root by walking up from pkgRoot
function findMonorepoRoot(startDir) {
  let dir = startDir;
  while (dir !== '/') {
    try {
      return execSync('git rev-parse --show-toplevel', { cwd: dir, encoding: 'utf8' }).trim();
    } catch {
      dir = dirname(dir);
    }
  }
  return startDir;
}

const monorepoRoot = findMonorepoRoot(pkgRoot);
const pkgDir = pkgRoot.replace(monorepoRoot + '/', '');

// Parse args
const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'HEAD~1';
const forceAll = args.includes('--all');

if (forceAll) {
  console.log(`[${pkgName}] Running full mutation (all files, forced)`);
  execSync('npx stryker run', { cwd: pkgRoot, stdio: 'inherit' });
  process.exit(0);
}

// Get changed files relative to this package
let changedFiles;
try {
  const output = execSync(`git diff ${base} --name-only`, {
    cwd: monorepoRoot,
    encoding: 'utf8',
  });
  changedFiles = output
    .split('\n')
    .filter(Boolean)
    .filter((f) => f.startsWith(pkgDir + '/'))
    .map((f) => f.replace(pkgDir + '/', ''));
} catch {
  console.log(`[${pkgName}] No git history — running full mutation`);
  execSync('npx stryker run', { cwd: pkgRoot, stdio: 'inherit' });
  process.exit(0);
}

// Read mutate patterns from the main stryker config
const strykerConfig = (await import(resolve(pkgRoot, 'stryker.config.mjs'))).default;
const srcPatterns = strykerConfig.mutate ?? ['src/**/*.ts', 'src/**/*.tsx'];

// Convert glob patterns to regexes
function globToRegex(pattern) {
  let regex = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  regex = regex.replace(/\*\*/g, '___DS___');
  regex = regex.replace(/\*/g, '[^/]*');
  regex = regex.replace(/\/___DS___\//g, '(/.*)?/');
  regex = regex.replace(/\/___DS___$/g, '(/.*)?');
  regex = regex.replace(/^___DS___\//g, '(.*/)?');
  return new RegExp('^' + regex + '$');
}

const filesToMutate = changedFiles.filter((f) =>
  srcPatterns.some((p) => globToRegex(p).test(f))
);

if (filesToMutate.length === 0) {
  console.log(`[${pkgName}] No source files changed — running full incremental mutation`);
  execSync('npx stryker run', { cwd: pkgRoot, stdio: 'inherit' });
  process.exit(0);
}

console.log(`[${pkgName}] Mutating only changed files: ${filesToMutate.join(', ')}`);
const mutateArg = filesToMutate.join(',');
execSync(
  `npx stryker run stryker.changes.config.mjs --mutate "${mutateArg}"`,
  { cwd: pkgRoot, stdio: 'inherit' }
);
