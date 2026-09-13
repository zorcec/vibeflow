// @vitest-environment jsdom
/**
 * Unit coverage for `capturePageWideElements` — the page.evaluate() callback
 * that produces verify-all-styles.json.
 *
 * Playwright serializes the callback's SOURCE and evaluates it in the browser,
 * so the callback must be self-contained. These tests execute the serialized
 * source in an isolated scope, which fails if the callback references any
 * module-scope identifier — the exact class of defect that silently disabled
 * page-wide capture.
 *
 * What this does NOT cover: the real browser boundary (DOM APIs, computed
 * styles). `tests/e2e/verify-page-capture.test.ts` covers that with chromium.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { capturePageWideElements } from "../../src/commands/verify.js";

type CaptureInput = { styles: string[]; maxElements: number };
type CaptureResult = ReturnType<typeof capturePageWideElements>;

/**
 * Mirrors Playwright's serialization: take the function's source text and
 * evaluate it in a fresh scope with no access to this module's bindings.
 */
function runFromSerializedSource(input: CaptureInput): CaptureResult {
  const source = capturePageWideElements.toString();
  // Stryker instruments the module with `stryMutAct_<hash>(...)` activation and
  // `stryCov_<hash>(...)` coverage calls whose helpers live in the instrumented
  // module's scope. A `new Function` body only sees global scope, so the
  // serialized copy would throw "stry..._<hash> is not defined" and abort the
  // mutation dry run. Install a no-op global per helper so the self-containment
  // assertion still executes the serialized source under mutation testing.
  for (const name of new Set(source.match(/stry(?:MutAct|Cov)_\w+/g) ?? [])) {
    (globalThis as Record<string, unknown>)[name] = () => false;
  }
  const factory = new Function(
    `return (${source})`,
  ) as () => (input: CaptureInput) => CaptureResult;
  return factory()(input);
}

describe("capturePageWideElements", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("runs from serialized source (self-contained, no module-scope references)", () => {
    document.body.innerHTML = `
      <div class="board" data-status="backlog">
        <article class="task-card" data-task-id="abc">First task</article>
      </div>
    `;

    const snapshot = runFromSerializedSource({
      styles: ["display", "color"],
      maxElements: 100,
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.truncated).toBe(false);

    const elements = Object.values(snapshot.elements) as Array<
      Record<string, any>
    >;
    const card = elements.find((e) => e.dataAttrs["task-id"] === "abc");

    expect(card).toBeDefined();
    expect(card!.tag).toBe("article");
    expect(card!.classes).toContain("task-card");
    expect(card!.selector).toContain("data-task-id=abc");
    expect(card!.text).toBe("First task");
    expect(card!.baseline).toHaveProperty("display");
    expect(card!.after).toHaveProperty("color");
  });

  it("accepts only plain, JSON-serializable data (no function arguments)", () => {
    document.body.innerHTML = `<div class="a">x</div>`;

    // A JSON round-trip is what the page boundary allows — functions cannot cross it.
    const input = JSON.parse(
      JSON.stringify({ styles: ["color"], maxElements: 10 }),
    ) as CaptureInput;

    expect(() => capturePageWideElements(input)).not.toThrow();
  });

  it("truncates once maxElements is reached", () => {
    document.body.innerHTML = `
      <div class="a">1</div>
      <div class="b">2</div>
      <div class="c">3</div>
    `;

    const snapshot = runFromSerializedSource({
      styles: ["color"],
      maxElements: 2,
    });

    expect(Object.keys(snapshot.elements)).toHaveLength(2);
    expect(snapshot.truncated).toBe(true);
  });
});
