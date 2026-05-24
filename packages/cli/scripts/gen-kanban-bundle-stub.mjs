#!/usr/bin/env node
/**
 * Generates a stub src/server/kanban-bundle.gen.ts so the CLI build can start
 * without a race condition. The real bundle is produced by the kanban-browser
 * IIFE build (tsup onSuccess) and overwrites this file.
 *
 * This script exists because kanban-bundle.gen.ts is no longer tracked in git
 * (it is auto-generated), but src/server/kanban-template.ts imports it at
 * build time. Without a stub, the ESM build of src/index.ts fails with
 * "Could not resolve ./kanban-bundle.gen.js".
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputTs = resolve(root, 'src/server/kanban-bundle.gen.ts');

writeFileSync(
  outputTs,
  `// AUTO-GENERATED stub — will be overwritten by tsup kanban-browser build.
// If you see this in production, run 'npm run build' to regenerate.
export const KANBAN_BUNDLE = "";
`,
  'utf-8',
);
