/**
 * Shipped runtime utility tests (owner ticket c478fd86):
 * `resolveHookRuntimeEntry` layout resolution and the
 * `readEnvelope()` / `reply()` / `log()` behavior of
 * `src/core/hooks/hook-runtime.mjs`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveHookRuntimeEntry } from "../../../src/core/hooks/runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_HOOKS = join(HERE, "..", "..", "..", "src", "core", "hooks");
const RUNTIME_SRC = join(SRC_HOOKS, "hook-runtime.mjs");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-runtime-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run a hook body with the given stdin, capturing stdout/stderr/exit. */
function runNode(
  file: string,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [file],
      { cwd: dir, timeout: 15000 },
      (err, stdout, stderr) =>
        resolvePromise({
          code: err && "code" in err ? (err.code as number) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

describe("resolveHookRuntimeEntry", () => {
  it("resolves to the real shipped file by default (src tree under test)", () => {
    const entry = resolveHookRuntimeEntry();
    expect(entry).toMatch(/hook-runtime\.mjs$/);
    expect(existsSync(entry)).toBe(true);
  });

  it("resolves the dist root layout (<root>/hook-loader.mjs -> <root>/hooks/)", () => {
    const root = join(dir, "pkg");
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hook-loader.mjs"), "// loader\n");
    const runtime = join(root, "hooks", "hook-runtime.mjs");
    writeFileSync(runtime, "// runtime\n");
    expect(resolveHookRuntimeEntry(join(root, "hook-loader.mjs"))).toBe(runtime);
  });

  it("resolves the dist cli layout (<root>/cli/hook-loader.mjs -> <root>/hooks/)", () => {
    const root = join(dir, "pkg");
    mkdirSync(join(root, "cli"), { recursive: true });
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "cli", "hook-loader.mjs"), "// loader\n");
    const runtime = join(root, "hooks", "hook-runtime.mjs");
    writeFileSync(runtime, "// runtime\n");
    expect(resolveHookRuntimeEntry(join(root, "cli", "hook-loader.mjs"))).toBe(runtime);
  });

  it("resolves the src tree (sibling of the hooks module)", () => {
    const hooksDir = join(dir, "src", "core", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const runtime = join(hooksDir, "hook-runtime.mjs");
    writeFileSync(runtime, "// runtime\n");
    expect(
      resolveHookRuntimeEntry(join(hooksDir, "hook-loader.mjs")),
    ).toBe(runtime);
  });
});

describe("hook-runtime.mjs (readEnvelope/reply/log)", () => {
  function writeUserHook(body: string): string {
    const file = join(dir, "user.after.mjs");
    writeFileSync(file, body);
    return file;
  }

  it("readEnvelope parses stdin and reply writes the single document; log goes to stderr", async () => {
    const file = writeUserHook(
      `import { readEnvelope, reply, log } from ${JSON.stringify(RUNTIME_SRC)};\n` +
        `const envelope = await readEnvelope();\n` +
        `log("saw", envelope.activity);\n` +
        `reply({ instructions: "kept:" + envelope.activity });\n`,
    );
    const result = await runNode(file, JSON.stringify({ activity: "task.update" }) + "\n");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      instructions: "kept:task.update",
    });
    expect(result.stderr).toContain("saw task.update");
  });

  it("reply({}) writes the no-op document", async () => {
    const file = writeUserHook(
      `import { readEnvelope, reply } from ${JSON.stringify(RUNTIME_SRC)};\n` +
        `await readEnvelope();\nreply({});\n`,
    );
    const result = await runNode(file, "{}\n");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({});
  });

  it("readEnvelope rejects trailing garbage and non-objects (caller decides the policy)", async () => {
    const file = writeUserHook(
      `import { readEnvelope } from ${JSON.stringify(RUNTIME_SRC)};\n` +
        `try { await readEnvelope(); } catch (err) { process.stderr.write("BAD:" + err.message + "\\n"); process.exit(3); }\n`,
    );
    const garbage = await runNode(file, '{}\n trailing\n');
    expect(garbage.code).toBe(3);
    expect(garbage.stderr).toContain("BAD:");
    const nonObject = await runNode(file, "[]\n");
    expect(nonObject.code).toBe(3);
    expect(nonObject.stderr).toContain("BAD:");
  });

  it("reply throws on undefined rather than writing half a document", async () => {
    const file = writeUserHook(
      `import { reply } from ${JSON.stringify(RUNTIME_SRC)};\n` +
        `try { reply(undefined); } catch (err) { process.stderr.write("THREW\\n"); process.exit(4); }\n`,
    );
    const result = await runNode(file, "");
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("THREW");
    expect(result.stdout).toBe("");
  });

  it("does no templating or expression evaluation (bytes move, nothing interprets)", async () => {
    // No eval/new Function anywhere in the utility.
    const source = readFileSync(RUNTIME_SRC, "utf8");
    expect(source).not.toMatch(/\beval\s*\(|\bnew\s+Function\b/);
    // A literal "${...}" in user data passes through untouched — the
    // utility never interpolates.
    const file = writeUserHook(
      `import { readEnvelope, reply } from ${JSON.stringify(RUNTIME_SRC)};\n` +
        `const envelope = await readEnvelope();\nreply({ instructions: envelope.text });\n`,
    );
    const marker = "${1+1} `whoami`";
    const result = await runNode(file, JSON.stringify({ text: marker }) + "\n");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ instructions: marker });
  });
});
