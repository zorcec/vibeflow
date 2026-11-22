/**
 * `vibeflow setup <agent>` end to end (ticket C4, parent 4e4feca1).
 *
 * Every assertion goes through the BUILT CLI with an isolated HOME, because the
 * command's whole job is a file under `$HOME` — the temp home IS the subject,
 * not test scaffolding. The installed file is read back and, where it matters,
 * checked with `node --check`: a stamp nobody can parse is not an install.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCliIsolated } from "./spawn-isolated.js";

const EXTENSION_PATH = [".pi", "agent", "extensions", "vibeflow-notifications.js"];

let cliHome: string;
let projectDir: string;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "vf-setup-e2e-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "vf-setup-e2e-proj-"));
});

afterEach(() => {
  rmSync(cliHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

async function runCli(args: string[]) {
  return spawnCliIsolated(args, {
    cwd: projectDir,
    home: cliHome,
    timeoutMs: 30_000,
  });
}

/** The installed extension path inside the temp HOME. */
const installedPath = () => join(cliHome, ...EXTENSION_PATH);

describe("vibeflow setup (e2e)", () => {
  it("installs the pi extension into $HOME and reports it as installed", async () => {
    const run = await runCli(["setup", "pi", "--json"]);
    expect(run.code, `stderr: ${run.stderr}`).toBe(0);

    const payload = JSON.parse(run.stdout) as {
      ok: boolean;
      target: string;
      support: string;
      installed: boolean;
      version: string | null;
      drift: boolean;
      path: string;
      actions: string[];
      restart?: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.target).toBe("pi");
    expect(payload.support).toBe("ready");
    expect(payload.installed).toBe(true);
    expect(payload.drift).toBe(false);
    expect(payload.version).toBeTruthy();
    expect(payload.path).toBe(installedPath());
    expect(payload.actions).toEqual([`wrote ${installedPath()}`]);
    expect(payload.restart).toBe("run /reload in pi");

    expect(existsSync(installedPath())).toBe(true);
    const firstLine = readFileSync(installedPath(), "utf-8").split("\n")[0];
    expect(firstLine).toBe(`// vibeflow-cli: ${payload.version}`);
    // The generated module is a real ES module, not a string blob.
    expect(() =>
      execFileSync(process.execPath, ["--check", installedPath()]),
    ).not.toThrow();
  });

  it("checks an up-to-date install with exit 0, and a corrupted stamp with exit 1", async () => {
    const install = await runCli(["setup", "pi", "--json"]);
    expect(install.code, `stderr: ${install.stderr}`).toBe(0);

    const fresh = await runCli(["setup", "pi", "--check", "--json"]);
    expect(fresh.code, `stderr: ${fresh.stderr}`).toBe(0);
    expect(JSON.parse(fresh.stdout)).toMatchObject({
      ok: true,
      target: "pi",
      installed: true,
      drift: false,
    });

    // Corrupt the stamp: the file is still there, but it is not from this CLI.
    writeFileSync(
      installedPath(),
      "// vibeflow-cli: 0.0.1-not-this-cli\nexport default function () {}\n",
    );

    const drifted = await runCli(["setup", "pi", "--check", "--json"]);
    expect(drifted.code, `stderr: ${drifted.stderr}`).toBe(1);
    const driftedPayload = JSON.parse(drifted.stdout) as {
      ok: boolean;
      installed: boolean;
      drift: boolean;
      version: string;
    };
    expect(driftedPayload.ok).toBe(false);
    expect(driftedPayload.installed).toBe(true);
    expect(driftedPayload.drift).toBe(true);
    expect(driftedPayload.version).toBe("0.0.1-not-this-cli");
  });

  it("checks a missing install with exit 1", async () => {
    const run = await runCli(["setup", "pi", "--check"]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("not installed");
  });

  it("reports claude as planned: ok, no file written", async () => {
    const run = await runCli(["setup", "claude", "--json"]);
    expect(run.code, `stderr: ${run.stderr}`).toBe(0);

    const payload = JSON.parse(run.stdout) as {
      ok: boolean;
      support: string;
      wrote?: boolean;
      installed: boolean;
      path: string | null;
      actions: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.support).toBe("planned");
    expect(payload.installed).toBe(false);
    expect(payload.path).toBeNull();
    expect(payload.actions).toEqual([]);
    expect(existsSync(installedPath())).toBe(false);
  });

  it("checks claude with exit 0 — planned is not a failure", async () => {
    const run = await runCli(["setup", "claude", "--check"]);
    expect(run.code, `stderr: ${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("not supported yet");
  });

  it("lists every target, and writes nothing", async () => {
    const run = await runCli(["setup", "--json"]);
    expect(run.code, `stderr: ${run.stderr}`).toBe(0);

    const payload = JSON.parse(run.stdout) as {
      ok: boolean;
      targets: Array<{ target: string; support: string; installed: boolean }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.targets.map((t) => t.target)).toEqual(["pi", "claude", "codex"]);
    expect(payload.targets.map((t) => t.support)).toEqual([
      "ready",
      "planned",
      "planned",
    ]);
    expect(payload.targets.every((t) => t.installed === false)).toBe(true);
    expect(existsSync(installedPath())).toBe(false);
  });

  it("refuses an unknown target with a usage error that lists the three ids", async () => {
    const run = await runCli(["setup", "nope", "--json"]);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    const envelope = JSON.parse(run.stderr) as {
      ok: boolean;
      error: { code: string; message: string; suggestion: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_USAGE");
    expect(envelope.error.message).toContain("nope");
    expect(envelope.error.suggestion).toContain("pi, claude, codex");
  });

  it("reports the honest restart hint only when it actually wrote the file", async () => {
    const first = await runCli(["setup", "pi"]);
    expect(first.code, `stderr: ${first.stderr}`).toBe(0);
    expect(first.stdout).toContain(installedPath());
    expect(first.stdout).toContain("restart: run /reload in pi");

    const second = await runCli(["setup", "pi"]);
    expect(second.code, `stderr: ${second.stderr}`).toBe(0);
    expect(second.stdout).toContain("already installed");
    expect(second.stdout).not.toContain("restart:");
  });
});
