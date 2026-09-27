/**
 * Recurrence guard for the `--json` machine-readability contract.
 *
 * The ruling: under `--json`, EVERY non-zero exit emits
 * `{ok:false, error:{code,message,retryable,suggestion?}}` on stderr with
 * stdout left clean. A refusal that prints chalk prose instead leaves a machine
 * consumer with empty stdout, no code, and nothing to branch on — so this test
 * fails when any `process.exitCode = ` assignment stops consulting the json
 * surface (`outputEnvelope(` / `opts.json`).
 *
 * How it finds a site without hard-coded line numbers:
 *   1. mask string, template-literal (including `${…}`) and comment contents, so
 *      a `{` inside a chalk template is not mistaken for a block;
 *   2. for every `process.exitCode = ` hit, walk BACKWARDS counting brackets:
 *      the first `{` reached with nothing still open is the opener of the block
 *      that encloses the assignment (this is the `try`/`catch`/`if` body, not
 *      some nested `if` that happens to sit closer);
 *   3. read the window from that opener to the assignment and require it to
 *      mention the json surface.
 *
 * Windows are located structurally, so editing the file above a site never
 * silently disarms the check — only reverting a site's own json handling does.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(__dirname, "../../src/index.ts");

/**
 * Sites that legitimately do NOT consult the json surface. Each entry must
 * match the site window while it exists, and every entry must be used — a stale
 * entry (site fixed or deleted) fails as loudly as a missing one, because an
 * unexplained allowlist entry is how the next regression slips through.
 */
const ALLOWLIST: Array<{ match: RegExp; reason: string }> = [
  {
    // reportProjectRootFailure — its only callers are the `serve`, `kanban` and
    // `mcp` commands in this file, and none of those three defines a `--json`
    // option, so no `--json` consumer can ever reach this refusal.
    match: /failure\.message/,
    reason:
      "reportProjectRootFailure: callers are serve/kanban/mcp, none of which define --json",
  },
];

type Site = { line: number; window: string };

/** Blanks string, template-literal and comment contents, preserving offsets. */
function maskLiterals(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\\") j++;
        j++;
      }
      blank(i, Math.min(j + 1, source.length));
      i = j + 1;
    } else if (c === "`") {
      // Blank the whole template, interpolations included: a blanked `${…}`
      // keeps the bracket count balanced, which is all this mask is for.
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "`") break;
        j++;
      }
      blank(i, Math.min(j + 1, source.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/**
 * Line index of the `{` that opens the block enclosing line `i`, found by
 * walking backwards and matching brackets. Returns 0 when the assignment is at
 * the top level of the module.
 */
function enclosingBlockStart(masked: string[], i: number): number {
  let open = 0;
  for (let j = i; j >= 0; j--) {
    for (let c = masked[j].length - 1; c >= 0; c--) {
      const ch = masked[j][c];
      if (ch === ")" || ch === "]" || ch === "}") {
        open++;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        if (open === 0) return j;
        open--;
      }
    }
  }
  return 0;
}

/** The text assigned to `process.exitCode` (statements may wrap over lines). */
function assignedValue(lines: string[], i: number): string {
  const text = lines.slice(i).join(" ");
  const end = text.indexOf(";");
  return (end === -1 ? text : text.slice(0, end))
    .replace(/^\s*process\.exitCode\s*=\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every non-zero `process.exitCode = ` assignment with its enclosing block. */
function findNonZeroExitSites(source: string): Site[] {
  const lines = source.split("\n");
  const masked = maskLiterals(source).split("\n");
  const sites: Site[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/process\.exitCode\s*=/.test(lines[i])) continue;
    const value = assignedValue(lines, i);
    if (/^(0|ExitCode\.SUCCESS)\b/.test(value)) continue;
    const start = enclosingBlockStart(masked, i);
    sites.push({ line: i + 1, window: lines.slice(start, i + 1).join("\n") });
  }
  return sites;
}

const JSON_SURFACE = /outputEnvelope\(|opts\.json|json:/;

describe("--json refusal recurrence guard", () => {
  const source = readFileSync(SOURCE, "utf-8");
  const sites = findNonZeroExitSites(source);

  it("locates the non-zero exit sites (the detector itself still works)", () => {
    expect(sites.length).toBeGreaterThan(20);
  });

  it("every non-zero exit consults the json surface or is allowlisted", () => {
    const used = new Set<RegExp>();
    const offenders: string[] = [];
    for (const site of sites) {
      if (JSON_SURFACE.test(site.window)) continue;
      const allowed = ALLOWLIST.find((entry) => entry.match.test(site.window));
      if (allowed) {
        used.add(allowed.match);
        continue;
      }
      offenders.push(
        `src/index.ts:${site.line} sets a non-zero exit without opts.json/outputEnvelope:\n${site.window}`,
      );
    }
    expect(offenders).toEqual([]);
    // A stale allowlist entry is a bug: it excuses a site that no longer needs
    // excusing and hides the next one that lands in the same place.
    const stale = ALLOWLIST.filter((entry) => !used.has(entry.match));
    expect(stale.map((entry) => entry.reason)).toEqual([]);
  });
});
