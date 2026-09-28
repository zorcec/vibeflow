/**
 * The documented error vocabulary, enforced against the README.
 *
 * The README is the only place a consumer learns which codes exist and what
 * they mean, so a code that exists in code but not in the table (or vice
 * versa) is a documentation defect that no other test can see.
 *
 * The rule this file exists for, and the reason it is stated in a test rather
 * than only in prose: the SCHEMA-ERROR class is not a vibeflow code. It is
 * raised by the MCP SDK's input validation before any handler runs, so
 * vibeflow neither chooses nor sees it. It must therefore never appear as a
 * row in the domain-code table, and the README must say so where a consumer
 * will actually read it.
 *
 * The code string is deliberately NOT pinned, in either direction: a client may
 * normalise this class into a label of its own (the Pi adapter reports
 * `call_failed`), and vibeflow does not own that string. Pinning it would
 * teach a reader to grep for a label the server never emits. The stable
 * contract is the SHAPE — `isError === true`, JSON-RPC `-32602`, the offending
 * field named — and that is pinned in tests/e2e/mcp-errors.test.ts instead.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const README = join(dirname(fileURLToPath(import.meta.url)), "../../../README.md");
const readme = readFileSync(README, "utf-8");
/**
 * Prose, whitespace-flattened. The README hard-wraps at ~100 columns and
 * emphasizes terms with `**`, so a raw substring of a sentence is a hostage to
 * where the line break and the bold markers happen to fall. Only the TABLE
 * scan below reads raw lines — it needs the row structure.
 */
const text = readme.replace(/\s+/g, " ");

/**
 * The first cell of every row of the domain-code table — the codes a
 * vibeflow handler produces. Row cells are `| `code` | …`; the leading cell of
 * a row is the only one that is a bare code, so this cannot pick up prose.
 */
function domainCodeRows(): string[] {
  const rows: string[] = [];
  for (const line of readme.split("\n")) {
    // The cell may be a SCREAMING_CASE name or a JSON-RPC number — the numeric
    // form is exactly what must never be there, so the detector has to be able
    // to see it or the rule is unfalsifiable. A leading `-` is included for the
    // same reason.
    const m = /^\|\s*`(-?[A-Z][A-Z0-9_]*|-?\d+)`\s*\|/.exec(line);
    if (m) rows.push(m[1]);
  }
  return rows;
}

describe("README error vocabulary: the schema-error class is not a domain code", () => {
  it("the domain-code table exists and is non-trivial", () => {
    // Shape guard: a regex that matched nothing would make every assertion
    // below vacuously true.
    const rows = domainCodeRows();
    expect(rows.length).toBeGreaterThan(5);
    expect(rows).toContain("TASK_NOT_FOUND");
  });

  it("-32602 is not a row in the domain-code table, and never will be", () => {
    const rows = domainCodeRows();
    expect(rows).not.toContain("-32602");
    // Not under any spelling either: a JSON-RPC code is a number, and none of
    // this vocabulary is.
    expect(rows.some((r) => /\d/.test(r))).toBe(false);
  });

  it("the README documents the schema-error path by its wire form", () => {
    expect(text).toContain("result.isError === true");
    expect(text).toContain("MCP error -32602");
    // The three properties a consumer is told to rely on.
    expect(text).toContain("before any vibeflow handler runs");
    expect(text).toMatch(/names the offending field/i);
    // …and the one it is told NOT to rely on.
    expect(text).toMatch(/code string is client-dependent|do not key on it/i);
  });

  it("the README tells consumers to recognise the class by shape, not by a code string", () => {
    expect(text).toMatch(/Recognise the class by its shape/i);
    // A client-side label may be mentioned ONLY to warn that it is not ours.
    const mentions = readme.match(/`call_failed`/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    const at = text.indexOf("`call_failed`");
    const context = text.slice(at - 500, at + 300);
    expect(context).toMatch(/client/i);
    expect(context).toMatch(/not to vibeflow|belongs to the client/i);
  });

  it("an unknown tool is NOT folded into the schema-error class", () => {
    // Both arrive as `MCP error -32602` (the SDK reports an unknown tool
    // through its input-validation path), but only one names a FIELD — and the
    // class's own recognition rule requires that. The README used to list
    // "an unknown tool" inside the class, so its rule excluded the case it
    // listed. Pinned here: the two are separated and the difference is stated
    // in terms of what the message names.
    expect(text).toMatch(/unknown tool/i);
    // The discriminator the README offers: what the message names.
    expect(text).toMatch(/the message names/i);
    expect(text).toMatch(/\*\*the tool\*\*/);
    expect(text).toMatch(/not a member of this class|is NOT a member/i);
    // The table row that separates them must name both remedies.
    expect(text).toMatch(/the offending field/i);
    expect(text).toMatch(/tools\/list/);
  });

  it("the README states the suggestion guarantee for every refusal", () => {
    expect(text).toMatch(/Every refusal carries a `suggestion`/);
    // …and names the generic catch wrappers, which used to carry none.
    for (const code of [
      "LIST_TASKS_ERROR",
      "GET_TASK_ERROR",
      "CREATE_TASK_ERROR",
      "UPDATE_TASK_ERROR",
      "ADD_COMMENT_ERROR",
      "ATTACH_FILE_ERROR",
      "EXPORT_PROMPT_ERROR",
      "VERIFY_TASK_ERROR",
      "PUSH_TASKS_ERROR",
      "CLAIM_TASK_ERROR",
    ]) {
      expect(text, `${code} is not named in the suggestion guarantee`).toContain(code);
    }
  });
});
