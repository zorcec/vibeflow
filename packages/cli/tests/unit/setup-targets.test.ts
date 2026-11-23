/**
 * `vibeflow setup <agent>` registry (ticket C4, parent 4e4feca1).
 *
 * The registry is the only place that knows an agent's install path, detection
 * rule, and drift definition, so these tests drive it directly — no CLI spawn,
 * no real HOME: every call passes a temp home, which is exactly the isolation
 * the contract promises.
 *
 * The generated pi extension is checked as ARTEFACT, not as a string: it must
 * parse (`node --check`) and carry the API facts it depends on (the version
 * stamp, the session hooks, `triggerTurn` on a notification and off on a
 * failure report), importing nothing but a Node builtin.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PI_EXTENSION_FILE,
  findTarget,
  getTargets,
  piExtensionPath,
  renderPiExtension,
  type AgentTarget,
} from "../../src/core/setup/targets.js";
import { CLI_VERSION } from "../../src/version.js";

let home: string;
let projectDir: string;

/** A stamp that can never be this CLI's version, whatever version it is. */
const FOREIGN_VERSION = CLI_VERSION === "9.9.9" ? "8.8.8" : "9.9.9";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vf-setup-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "vf-setup-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/**
 * Run `fn` with every env var of this prefix removed, then restore them. The
 * suite can itself be running inside an agent (pi sets `PI_*`), so a detection
 * test is only meaningful when the ambient agent's own variables are gone.
 */
function withoutEnv(prefix: string, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith(prefix)) continue;
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

const scope = () => ({ home, projectDir, project: false });

/** The install contract, spelled once so overrides cannot drift from it. */
type InstallOptions = Parameters<AgentTarget["install"]>[0];

const installOpts = (over: Partial<InstallOptions> = {}): InstallOptions => ({
  home,
  projectDir,
  project: false,
  force: false,
  dryRun: false,
  version: CLI_VERSION,
  ...over,
});

/** `install` on a target that must exist — keeps the assertions below honest. */
function target(id: string) {
  const found = findTarget(id);
  if (found === undefined) throw new Error(`no setup target ${id}`);
  return found;
}

describe("setup target registry", () => {
  it("is exactly pi, claude and codex, with pi the only ready target", () => {
    const targets = getTargets();
    expect(targets.map((t) => t.id)).toEqual(["pi", "claude", "codex"]);
    expect(targets.map((t) => t.support)).toEqual(["ready", "planned", "planned"]);
    for (const t of targets) expect(t.title).toBeTruthy();
  });

  it("resolves ids and refuses unknown ones", () => {
    expect(findTarget("pi")?.id).toBe("pi");
    expect(findTarget("nope")).toBeUndefined();
  });
});

describe("detect", () => {
  it("finds pi through PI_* env and names the matching variable", () => {
    withoutEnv("PI_", () => {
      process.env.PI_SESSION_ID = "session-1";
      const detected = target("pi").detect(home);
      expect(detected.present).toBe(true);
      expect(detected.evidence).toBe("env PI_SESSION_ID");
    });
  });

  it("finds pi through ~/.pi/agent when no PI_* variable is set", () => {
    withoutEnv("PI_", () => {
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      const detected = target("pi").detect(home);
      expect(detected.present).toBe(true);
      expect(detected.evidence).toContain(join(home, ".pi", "agent"));
    });
  });

  it("reports pi absence with the paths it checked", () => {
    withoutEnv("PI_", () => {
      const detected = target("pi").detect(home);
      expect(detected.present).toBe(false);
      expect(detected.evidence).toContain(join(home, ".pi", "agent"));
    });
  });

  it("finds codex through $HOME/.codex and reports absence with the paths it checked", () => {
    expect(target("codex").detect(home).present).toBe(false);

    mkdirSync(join(home, ".codex"), { recursive: true });
    const detected = target("codex").detect(home);
    expect(detected.present).toBe(true);
    expect(detected.evidence).toBe(`dir ${join(home, ".codex")}`);
  });

  it("finds claude through CLAUDE_* env", () => {
    withoutEnv("CLAUDE_", () => {
      process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
      const detected = target("claude").detect(home);
      expect(detected.present).toBe(true);
      expect(detected.evidence).toBe("env CLAUDE_CODE_ENTRYPOINT");
    });
  });
});

describe("install", () => {
  it("writes the extension with the version stamp and reports the path", () => {
    const result = target("pi").install(installOpts());
    const path = join(home, ".pi", "agent", "extensions", PI_EXTENSION_FILE);

    expect(result).toMatchObject({ ok: true, target: "pi", wrote: true, path });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8").split("\n")[0]).toBe(
      `// vibeflow-cli: ${CLI_VERSION}`,
    );
    expect(result.message).toContain(path);
  });

  it("honours --project: the file lands under the project, not the home", () => {
    const result = target("pi").install(installOpts({ project: true }));
    const path = join(projectDir, ".pi", "extensions", PI_EXTENSION_FILE);

    expect(result.path).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "extensions", PI_EXTENSION_FILE))).toBe(
      false,
    );
  });

  it("is a no-op without --force on a second run and keeps the installed version", () => {
    const first = target("pi").install(installOpts());
    expect(first.wrote).toBe(true);

    const second = target("pi").install(installOpts());
    expect(second.wrote).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.message).toContain(CLI_VERSION);
    expect(target("pi").status(scope()).version).toBe(CLI_VERSION);
  });

  it("overwrites on --force", () => {
    target("pi").install(installOpts({ version: FOREIGN_VERSION }));
    const forced = target("pi").install(installOpts({ force: true }));

    expect(forced.wrote).toBe(true);
    expect(target("pi").status(scope()).version).toBe(CLI_VERSION);
    expect(target("pi").status(scope()).drift).toBe(false);
  });

  it("writes nothing on --dry-run but still reports the path", () => {
    const result = target("pi").install(installOpts({ dryRun: true }));
    const path = join(home, ".pi", "agent", "extensions", PI_EXTENSION_FILE);

    expect(result).toMatchObject({ ok: true, wrote: false, path });
    expect(result.message).toContain(path);
    expect(existsSync(path)).toBe(false);
    expect(target("pi").status(scope()).installed).toBe(false);
  });

  it("planned targets never write, and point at the --exec pipe", () => {
    for (const id of ["claude", "codex"]) {
      const result = target(id).install(installOpts());
      expect(result).toMatchObject({ ok: true, target: id, wrote: false });
      expect(result.path).toBeUndefined();
      expect(result.message).toContain("vibeflow notifications --follow --exec");
    }
    expect(existsSync(join(home, ".pi"))).toBe(false);
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
  });
});

describe("status", () => {
  it("reports not-installed for a clean home", () => {
    expect(target("pi").status(scope())).toMatchObject({
      installed: false,
      path: join(home, ".pi", "agent", "extensions", PI_EXTENSION_FILE),
    });
    expect(target("claude").status(scope()).installed).toBe(false);
  });

  it("flags drift when the stamp is not this CLI's version", () => {
    const path = piExtensionPath(scope());
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `// vibeflow-cli: ${FOREIGN_VERSION}\nexport default function () {}\n`);

    const state = target("pi").status(scope());
    expect(state).toMatchObject({
      installed: true,
      version: FOREIGN_VERSION,
      drift: true,
      path,
    });
  });

  it("treats an unstamped or unreadable file as drift, never as a throw", () => {
    const path = piExtensionPath(scope());
    mkdirSync(path, { recursive: true }); // a DIRECTORY: exists, cannot be read as a file

    const state = target("pi").status(scope());
    expect(state.installed).toBe(true);
    expect(state.version).toBeUndefined();
    expect(state.drift).toBe(true);
  });
});

describe("renderPiExtension", () => {
  it("generates a parseable ES module carrying the stamp and the pi API calls", () => {
    const source = renderPiExtension(CLI_VERSION, "/opt/vibeflow/dist/index.js");
    const file = join(home, "vibeflow-notifications.mjs");
    writeFileSync(file, source);

    // `node --check` is the syntax gate; the .mjs name pins ESM parsing.
    expect(() => execFileSync(process.execPath, ["--check", file])).not.toThrow();

    expect(source.split("\n")[0]).toBe(`// vibeflow-cli: ${CLI_VERSION}`);
    expect(source).toContain("export default function (pi)");
    expect(source).toContain("triggerTurn: true");
    expect(source).toContain("triggerTurn: false");
    expect(source).toContain('pi.registerCommand("vibeflow-status"');
    expect(source).toContain('pi.on("session_start"');
    expect(source).toContain('pi.on("session_shutdown"');
    expect(source).toContain('"--follow", "--json"');
    // The extension follows the project it was INSTALLED for, not pi's cwd:
    // a session started in a parent directory with its own .vibeflow used to
    // follow that unrelated local store and stay silent.
    expect(source).toContain("INSTALL_PROJECT");
    expect(source).toContain("VIBEFLOW_NOTIFY_PROJECT");
    expect(source).toMatch(/spawn\(command, args, \{[^}]*cwd/);
    // The user must be able to switch the feed off without editing this file:
    // two commands plus an environment opt-out.
    expect(source).toContain('registerCommand("vibeflow-off"');
    expect(source).toContain('registerCommand("vibeflow-on"');
    expect(source).toContain("VIBEFLOW_NOTIFY");
    expect(source).toContain("let enabled = process.env.VIBEFLOW_NOTIFY !== \"0\"");
    expect(source).toMatch(/if \(!enabled \|\| child !== null\) return;/);
    // Bookkeeping-only updates are filtered in the extension too, so the feed
    // stays quiet on any deployed backend (the server filter lands with the
    // next deploy; this one lands with a /reload).
    expect(source).toContain('const METADATA_ONLY = ["updatedAt", "sortKey", "rev"]');
    expect(source).toMatch(/keys\.every\(\(key\) => METADATA_ONLY\.includes\(key\)\)/);
    // Substance without fattening the payload: one CLI read per comment/create
    // event, and the update line summarised from the event's own `to` values.
    expect(source).toContain("const EXCERPT_CHARS = 70");
    expect(source).toContain('args.push("--get", taskId, "--json")');
    expect(source).toContain("function describeWith(event, detail)");
    expect(source).toContain("function formalues(event)");
    // The read must never outlive the feed: bounded, and it must not emit
    // notifications of its own (VIBEFLOW_EVENTS=0 on the child).
    expect(source).toContain("}, 5000);");
    expect(source).toContain("VIBEFLOW_EVENTS: \"0\"");
    // Standing instruction: how to react to a comment, in as few words as
    // possible, delivered through the system prompt (no turn burned).
    expect(source).toContain("const INSTRUCTIONS = [");
    expect(source).toContain("A task.comment is a request");
    expect(source).toContain("answer ON THAT TASK with vibeflow tasks --edit");
    // The generated source is a JS STRING: the reply template must survive as
    // escaped quotes, or it silently truncates at --comment (node --check still
    // passes, because \"<reply>\" parses as a comparison).
    expect(source).toMatch(/--comment \\"<reply>\\"/);
    expect(source).toContain('pi.on("before_agent_start"');
    expect(source).toContain("systemPrompt: base");
    // Self-contained: only Node builtins, nothing to resolve at install time.
    // `node:fs` is the existence check on the pinned project dir, so a deleted
    // install target falls back to cwd instead of breaking the extension.
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["node:child_process", "node:fs"]);
    expect(imports.every((spec) => spec.startsWith("node:"))).toBe(true);
  });

  it("embeds the resolved CLI entry, and degrades to PATH when there is none", () => {
    const withEntry = renderPiExtension("1.2.3", "/opt/vibeflow/dist/index.js");
    expect(withEntry).toContain('const CLI_ENTRY = "/opt/vibeflow/dist/index.js";');

    const withoutEntry = renderPiExtension("1.2.3", null);
    expect(withoutEntry).toContain("const CLI_ENTRY = null;");
    expect(withoutEntry).toContain('=== null ? "vibeflow"');
  });
});
