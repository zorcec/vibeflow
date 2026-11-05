/**
 * Trust tests (ADR-0006): direnv-style sha256 trust, HONEST wording (code
 * execution, not a sandbox; entry-file hash is not transitive integrity),
 * global/defaults trusted without prompting, non-TTY refusal in scope,
 * hash-change re-prompt, and the symlink-escape veto.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TRUST_ENV_BYPASS,
  checkHookTrust,
  loadTrustStore,
  recordTrust,
  sha256File,
  trustFilePath,
} from "../../../src/core/hooks/trust.js";

let home: string;
let hookFile: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hook-trust-home-"));
  const proj = mkdtempSync(join(tmpdir(), "hook-trust-proj-"));
  hookFile = join(proj, "after-task.update.mjs");
  writeFileSync(hookFile, `// hook v1\n`);
});

describe("checkHookTrust", () => {
  it("trusts global/defaults files without prompting", async () => {
    const verdict = await checkHookTrust("/home/u/.vibeflow/hooks/after-x.mjs", {
      isProjectRoot: false,
      escapedRoot: false,
      home,
      tty: false,
    });
    expect(verdict).toEqual({ trusted: true, reason: "global-or-default" });
    expect(loadTrustStore(home)).toEqual({});
  });

  it("refuses non-TTY project hooks and says why (safety property, in scope)", async () => {
    const errLines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error intercept for assertion
    process.stderr.write = (c: string) => {
      errLines.push(String(c));
      return true;
    };
    try {
      const verdict = await checkHookTrust(hookFile, {
        isProjectRoot: true,
        escapedRoot: false,
        home,
        tty: false,
      });
      expect(verdict).toEqual({ trusted: false, reason: "non-tty" });
    } finally {
      process.stderr.write = orig;
    }
    const out = errLines.join("");
    expect(out).toContain("non-interactive");
    // HONEST wording: code execution, not a sandbox.
    expect(out).toContain("CODE EXECUTION");
    expect(out).toContain("not a sandbox");
    expect(out).toContain("not its imports");
  });

  it("honours the explicit env bypass and logs it", async () => {
    const errLines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error intercept for assertion
    process.stderr.write = (c: string) => {
      errLines.push(String(c));
      return true;
    };
    try {
      const verdict = await checkHookTrust(hookFile, {
        isProjectRoot: true,
        escapedRoot: false,
        home,
        tty: false,
        env: { PATH: process.env.PATH ?? "", HOME: home, [TRUST_ENV_BYPASS]: "1" },
      });
      expect(verdict).toEqual({ trusted: true, reason: "env-bypass" });
    } finally {
      process.stderr.write = orig;
    }
    expect(errLines.join("")).toContain(TRUST_ENV_BYPASS);
  });

  it("prompts on TTY: 'y' records the entry-file hash", async () => {
    const verdict = await checkHookTrust(hookFile, {
      isProjectRoot: true,
      escapedRoot: false,
      home,
      tty: true,
      prompt: async () => "y",
    });
    expect(verdict).toEqual({ trusted: true, reason: "recorded" });
    expect(loadTrustStore(home)[hookFile]?.sha256).toBe(sha256File(hookFile));
    expect(trustFilePath(home)).toContain(".vibeflow");
  });

  it("a changed file re-prompts; declining reports the change", async () => {
    await checkHookTrust(hookFile, {
      isProjectRoot: true,
      escapedRoot: false,
      home,
      tty: true,
      prompt: async () => "y",
    });
    writeFileSync(hookFile, `// hook v2 — changed\n`);
    const verdict = await checkHookTrust(hookFile, {
      isProjectRoot: true,
      escapedRoot: false,
      home,
      tty: true,
      prompt: async () => "n",
    });
    expect(verdict.trusted).toBe(false);
    expect(verdict).toEqual({ trusted: false, reason: "changed" });
  });

  it("a .hook.ts source edit invalidates trust and re-prompts (Stage 4, source-based)", async () => {
    // The recorded hash covers the TypeScript SOURCE file: editing it
    // re-prompts exactly like a .mjs edit (Stage 1.5 entry-hash rule —
    // the hash is per entry file, never transitive over its imports).
    const tsFile = hookFile.replace(/\.mjs$/, ".hook.ts");
    writeFileSync(tsFile, `export default async () => ({});\n`);
    await checkHookTrust(tsFile, {
      isProjectRoot: true,
      escapedRoot: false,
      home,
      tty: true,
      prompt: async () => "y",
    });
    writeFileSync(tsFile, `export default async () => ({ instructions: "edited" });\n`);
    const verdict = await checkHookTrust(tsFile, {
      isProjectRoot: true,
      escapedRoot: false,
      home,
      tty: true,
      prompt: async () => "n",
    });
    expect(verdict.trusted).toBe(false);
    expect(verdict).toEqual({ trusted: false, reason: "changed" });
  });

  it("a recorded hash passes without prompting", async () => {
    recordTrust(home, hookFile, sha256File(hookFile));
    let prompted = false;
    const verdict = await checkHookTrust(hookFile, {
      isProjectRoot: true,
      escapedRoot: false,
      home,
      tty: true,
      prompt: async () => {
        prompted = true;
        return "y";
      },
    });
    expect(verdict).toEqual({ trusted: true, reason: "recorded" });
    expect(prompted).toBe(false);
  });

  it("the prompt itself states the trust boundary honestly", async () => {
    const questions: string[] = [];
    await checkHookTrust(hookFile, {
      isProjectRoot: true,
      escapedRoot: false,
      home,
      tty: true,
      prompt: async (q) => {
        questions.push(q);
        return "n";
      },
    });
    const q = questions.join("\n");
    expect(q).toContain("CODE EXECUTION");
    expect(q).toContain("not a sandbox");
    expect(q).toContain("entry file only");
  });

  it("'d' prints the file, then a second answer decides", async () => {
    const answers = ["d", "y"];
    const verdict = await checkHookTrust(hookFile, {
      isProjectRoot: true,
      escapedRoot: false,
      home,
      tty: true,
      prompt: async () => answers.shift() ?? "n",
    });
    expect(verdict).toEqual({ trusted: true, reason: "recorded" });
  });

  it("symlink escapes never inherit trust", async () => {
    const verdict = await checkHookTrust(hookFile, {
      isProjectRoot: false,
      escapedRoot: true,
      home,
      tty: true,
      prompt: async () => "y",
    });
    expect(verdict).toEqual({ trusted: false, reason: "escaped-root" });
  });
});
