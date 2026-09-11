/**
 * SSR markup tests for the HighlightsBanner (What's New modal region).
 *
 * Uses renderToString (same pattern as child-row-remove.test.tsx): verifies
 * the banner renders its label and version chips, and renders nothing when
 * there are no tagged highlights.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { HighlightsBanner } from "../../../src/client/kanban/HighlightsBanner.js";
import type { Highlight } from "../../../src/client/kanban/whats-new.js";

const single: Highlight[] = [{ version: "0.3.0", text: "Big new thing" }];
const multi: Highlight[] = [
  { version: "0.3.0", text: "Big new thing" },
  { version: "0.2.0", text: "Older highlight" },
];

describe("HighlightsBanner", () => {
  it("renders the label and highlight text", () => {
    const html = renderToString(<HighlightsBanner items={single} />);
    expect(html).toContain("Highlights");
    expect(html).toContain("Big new thing");
    expect(html).toContain('data-role="highlights-region"');
  });

  it("shows per-version chips only when spanning versions", () => {
    const one = renderToString(<HighlightsBanner items={single} />);
    expect(one).not.toContain("0.3.0");
    const two = renderToString(<HighlightsBanner items={multi} />);
    expect(two).toContain("0.3.0");
    expect(two).toContain("0.2.0");
  });

  it("renders nothing when there are no highlights", () => {
    expect(renderToString(<HighlightsBanner items={[]} />)).toBe("");
  });
});
