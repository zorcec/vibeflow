import { test, expect, describe } from 'vitest';
import { spawn } from 'child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getKanbanHtml } from '../../src/server/kanban-template';
import { CLI_ENTRY, isolatedCliEnv } from './spawn-isolated.js';

// ── Static kanban template checks (no server needed) ────────────────────────

describe('kanban template — static checks', () => {
  const templatePath = resolve('src/server/kanban-template.html');
  const html = readFileSync(templatePath, 'utf8');

  test('task modal uses design-system background color (#0f172a)', () => {
    // Old broken color was #0f1117; should now be #0f172a
    expect(html).not.toContain('background:#0f1117');
    expect(html).toContain('background:#0f172a');
  });

  test('task modal borders use design-system color (#334155)', () => {
    // Old inconsistent border was #1c1f28; should now be #334155
    expect(html).not.toContain('border-bottom:1px solid #1c1f28');
    expect(html).not.toContain('border-top:1px solid #1c1f28');
  });

  test('task modal status select matches design system', () => {
    // Old color: #1c2130 / #2d3748 — should now use #0f172a / #334155
    expect(html).not.toContain('background:#1c2130');
    expect(html).not.toContain('border:1px solid #2d3748');
  });

  test('card bottom row has NO linear-gradient', () => {
    // Gradient was removed from bottom row background (task 90fde655)
    const bottomRowGradient = "background:linear-gradient(to bottom, rgba(15,23,42,0.95) 0%, rgba(15,23,42,0) 100%)";
    expect(html).not.toContain(bottomRowGradient);
  });

  test('file-path dialog element exists (styled alternative to prompt())', () => {
    const runtimeHtml = getKanbanHtml({ port: 3799 });
    expect(runtimeHtml).toContain('id="root"');
    expect(runtimeHtml).toContain('window.__PORT__ = 3799');
  });

  test('promptFilePath function replaces native prompt() for file linking', () => {
    const runtimeHtml = getKanbanHtml({ port: 3799 });
    expect(runtimeHtml).not.toContain("prompt('Enter absolute file path to link:')");
  });

  test('card description uses explicit webkit-line-clamp for 2-line limit', () => {
    expect(html).toContain('-webkit-line-clamp:2');
    expect(html).not.toContain("className = 'text-xs line-clamp-2'");
  });
});

// ── Live server check (JS syntax validation) ─────────────────────────────────

test('kanban HTML contains only valid JavaScript', async () => {
  const port = 3098;
  // Isolated HOME + temp cwd (ticket 8ac96ef9): this spawn once inherited
  // the operator's real HOME, and its logout path deleted
  // ~/.vibeflow/token. A long-lived server cannot use spawnCliIsolated
  // (which resolves on exit), so the env is built by isolatedCliEnv — the
  // same chokepoint — with a temp HOME and a temp cwd.
  const home = mkdtempSync(join(tmpdir(), 'kanban-syntax-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'kanban-syntax-cwd-'));
  // W1: the CLI validates the root before serving (git repo or .vibeflow
  // store). Seed the store marker in the spawn cwd.
  mkdirSync(join(cwd, '.vibeflow'), { recursive: true });
  const serverProcess = spawn(process.execPath, [CLI_ENTRY, 'serve', '--port', String(port)], {
    cwd,
    env: isolatedCliEnv({ home, cwd }),
    stdio: 'ignore',
  });

  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 1500));

  try {
    const res = await fetch(`http://localhost:${port}/kanban`);
    expect(res.ok).toBe(true);

    const html = await res.text();

    // Extract all inline script blocks
    // eslint-disable-next-line security/detect-unsafe-regex -- matches balanced script tags; bounded by start/end delimiters
    const scriptRegex = /<script(?:\s[^>]*)?>([^]*?)<\/script>/g;
    let match;
    const scripts: { index: number; length: number; content: string }[] = [];

    while ((match = scriptRegex.exec(html)) !== null) {
      const js = match[1].trim();
      if (js && js.length >= 100) {
        scripts.push({
          index: scripts.length,
          length: js.length,
          content: js,
        });
      }
    }

    expect(scripts.length).toBeGreaterThan(0);

    // Validate each script block has valid JavaScript syntax
    for (const script of scripts) {
      try {
        new Function(script.content);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Script block ${script.index} (${script.length} chars) has invalid syntax: ${error}\n` +
          `First 200 chars: ${script.content.substring(0, 200)}`
        );
      }
    }
  } finally {
    serverProcess.kill();
    await new Promise(resolve => setTimeout(resolve, 100));
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
