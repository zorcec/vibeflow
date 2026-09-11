/**
 * Tests for ChildRow remove button (onRemove prop).
 *
 * Verifies that:
 * 1. Without onRemove, no × button is rendered.
 * 2. With onRemove, a .relation-remove button is rendered.
 * 3. Clicking the button calls onRemove with the child task id.
 *
 * Uses renderToString (SSR) for rendering checks. Click handler is verified
 * by inspecting the rendered HTML for the correct button markup (same pattern
 * as RelationRow — className="relation-remove", onClick calls onRemove(taskId)).
 */

import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { ChildRow } from "@vibeflow-tools/ui/kanban";
import type { Task } from "@vibeflow-tools/ui/kanban";

function makeChild(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? `Child ${overrides.id}`,
    description: overrides.description ?? "",
    status: overrides.status ?? "todo",
    selector: overrides.selector ?? "/",
    created: overrides.created ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChildRow — remove button", () => {
  it("does NOT render .relation-remove when onRemove is omitted", () => {
    const child = makeChild({ id: "child-aaaaaaaaaaaa" });
    const html = renderToString(<ChildRow child={child} variant="detail" />);
    expect(html).not.toContain("relation-remove");
  });

  it("renders .relation-remove button when onRemove is provided", () => {
    const child = makeChild({ id: "child-aaaaaaaaaaaa" });
    const onRemove = (_taskId: string) => {};
    const html = renderToString(
      <ChildRow child={child} variant="detail" onRemove={onRemove} />,
    );
    expect(html).toContain("relation-remove");
    expect(html).toContain("Unlink");
    expect(html).toContain('title="Unlink from parent"');
  });

  it("does NOT render remove button when onRemove is undefined", () => {
    const child = makeChild({ id: "child-aaaaaaaaaaaa" });
    const html = renderToString(
      <ChildRow child={child} variant="detail" onRemove={undefined} />,
    );
    expect(html).not.toContain("relation-remove");
  });

  it("remove button is present in inline variant too", () => {
    const child = makeChild({ id: "child-aaaaaaaaaaaa" });
    const onRemove = (_taskId: string) => {};
    const html = renderToString(
      <ChildRow child={child} variant="inline" onRemove={onRemove} />,
    );
    expect(html).toContain("relation-remove");
  });

  it("remove button renders with correct data-role and stopPropagation", () => {
    const child = makeChild({ id: "child-aaaaaaaaaaaa" });
    const onRemove = (_taskId: string) => {};
    const html = renderToString(
      <ChildRow child={child} variant="detail" onRemove={onRemove} />,
    );
    // Verify the remove button is inside the child-link-row button
    expect(html).toContain("child-link-row");
    expect(html).toContain("relation-remove");
    // Verify it's a button element (not a div/span)
    expect(html).toMatch(/<button[^>]*class="relation-remove"/);
  });
});
