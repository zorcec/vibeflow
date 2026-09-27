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
 *
 * ── WHAT THIS GUARD CANNOT SEE (read before trusting a green run) ──────────
 *
 * It is a HEURISTIC over masked text, not a parser, and it has named blind
 * spots. Two of them are exercised as tests below; the rest are stated here so
 * nobody mistakes this for a proof:
 *
 *   B1. EXIT 0 IS INVISIBLE. The detector is keyed on non-zero
 *       `process.exitCode` assignments, so prose written to stdout by a
 *       SUCCESSFUL `--json` run cannot be seen here at all. Two real sites
 *       were exactly this: the `--edit` usage-help block (exit 0, 750+ bytes of
 *       chalk) and the auto-push lines printed AFTER the success envelope.
 *       `tests/e2e/tasks-json-refusals.test.ts` owns that class now, by
 *       asserting stdout parses for a table of invocations.
 *   B2. A COMMENT SATISFIES THE CHECK. The window only has to MENTION
 *       `opts.json` / `outputEnvelope(` / `json:` — including inside a comment
 *       or a string. A site can therefore be "compliant" on paper while the
 *       prose still reaches stdout. See the test below.
 *   B3. MASKING IS LEXICAL, NOT SYNTACTIC. Only strings, template literals
 *       and comments are blanked. A `{` or `}` inside a REGEX literal
 *       (`/\{2\}/`) still counts, and a `/` that starts neither a comment nor
 *       a string (division, a path) can send the masker into a bogus string
 *       and blank real code. Either way the bracket walk lands on the wrong
 *       block.
 *   B4. A BLANKED `${…}` IS INVISIBLE CODE. Masking a template literal blanks
 *       its interpolations whole, so a `process.exitCode = ` written INSIDE
 *       `${…}` is neither detected nor counted — the mask is balanced on
 *       purpose, and that balance is exactly what hides it.
 *   B5. THE WINDOW IS TEXTUAL CONTEXT, NOT A CALL GRAPH. It proves the json
 *       surface is mentioned between the enclosing block's `{` and the exit
 *       assignment. A site that routes its envelope through a helper CALLED
 *       from that block passes; so does one that mentions the symbol and then
 *       never writes an envelope.
 *   B6. FALSE POSITIVES ARE POSSIBLE. Detection matches the raw line, so a
 *       string containing the literal text `process.exitCode = ` is treated as
 *       a site. The offender list would then name a line that is not one.
 *
 * The allowlist below is the escape hatch, and it is deliberately narrow: one
 * entry, each with a reason, and a stale entry fails as loudly as a missing one.
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
export function maskLiterals(source: string): string {
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
export function findNonZeroExitSites(source: string): Site[] {
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

export const JSON_SURFACE = /outputEnvelope\(|opts\.json|json:/;

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

/**
 * The blind spots above, exercised rather than merely described. These tests
 * do not fail on a regression — they FAIL IF THE GUARD EVER STARTS BEHAVING AS
 * IF IT COULD SEE, so that a future reader who assumes soundness has to read
 * the header first. The guard itself is not weakened by them.
 */
describe("--json refusal guard: named blind spots", () => {
  it("B2 — a COMMENT mentioning opts.json satisfies the check", () => {
    // The window only has to mention the json surface, and masking blanks
    // comments, so a comment in the enclosing block is enough to pass with no
    // envelope written anywhere. Demonstrated here so "the guard is green" is
    // never read as "this site emits an envelope".
    const synthetic = [
      "function refuse(opts) {",
      "  if (opts.bad) {",
      "    // TODO: honour opts.json on this path",
      "    console.log('✗ bad flag');",
      "    process.exitCode = 1;",
      "  }",
      "}",
    ].join("\n");
    const sites = findNonZeroExitSites(synthetic);
    expect(sites).toHaveLength(1);
    // The site's window satisfies the rule…
    expect(JSON_SURFACE.test(sites[0].window)).toBe(true);
    // …while the block writes no envelope at all.
    expect(sites[0].window).not.toContain("outputEnvelope(");
  });

  it("B3 — a brace inside a regex literal is not masked, so the walk can land wrong", () => {
    // Masking handles strings, templates and comments — not regex literals. An
    // unbalanced brace in one shifts the backward count, and the reported
    // window is then some other block entirely. The assertion is that the mask
    // leaves the regex characters visible, which is the cause; a parser-based
    // detector would not have this problem.
    const withRegexBrace = "if (/\\{2\\}/.test(s)) {";
    const withStringBrace = 'if ("{" === s) {';
    expect(maskLiterals(withRegexBrace)).toContain("if (/");
    expect(maskLiterals(withRegexBrace)).toContain("\\{2\\}");
    // The same brace inside a STRING is masked, which is the case that works.
    expect(maskLiterals(withStringBrace)).not.toContain('"{"');
  });

  it("B1 — exit 0 sites are invisible to the detector by construction", () => {
    // Two real regressions (the `--edit` usage-help block and the post-envelope
    // auto-push lines) were prose on stdout with exit 0. This is why they are
    // the guard's structural blind spot, and why the e2e sweep exists.
    const synthetic = [
      "function help(opts) {",
      "  if (opts.json) {",
      "    console.log('vibeflow tasks --edit — LLM Usage Instructions');",
      "  }",
      "}",
    ].join("\n");
    expect(findNonZeroExitSites(synthetic)).toHaveLength(0);
  });
});
