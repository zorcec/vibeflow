// @vitest-environment jsdom
/**
 * Local/online parity guard for FilterBar bulk "Remove" (uvbpv6ax).
 *
 * Online wires the shared FilterBar's `onRemoveTagFromAll` to the tRPC
 * `task.removeTagFromAll` call; local must pass the SAME prop shape over
 * the SAME operation, or a future fork silently hides the action again
 * (which is exactly the bug this ticket fixes — local App never passed
 * the prop, so the shared FilterBar hid the button).
 *
 * This test fails on a fork in either direction:
 * - if local `api.removeTagFromAll` stops matching
 *   `(tag: string) => Promise<number>`, the render below stops compiling
 *   and the arity assertion fails;
 * - if local `App.tsx` stops passing `onRemoveTagFromAll` (or stops
 *   refreshing on success), the source tripwire fails.
 *
 * Rendering uses renderToString (SSR), the same pattern as the ChildRow
 * suite — no DOM driver needed. The open-dropdown behaviour is covered in
 * the shared UI suite; here SSR proves the wiring compiles and that the
 * closed dropdown renders no Remove action (the hidden condition).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { FilterBar } from "@vibeflow-tools/ui/kanban";
import type { Task } from "@vibeflow-tools/ui/kanban";
import { api } from "../../../src/client/kanban/api.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_TSX = readFileSync(
  join(HERE, "..", "..", "..", "src", "client", "kanban", "App.tsx"),
  "utf-8",
);

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    description: "",
    status: "todo",
    selector: "/",
    ...overrides,
  };
}

describe("FilterBar bulk Remove parity (uvbpv6ax)", () => {
  it("local api.removeTagFromAll plugs straight into the shared onRemoveTagFromAll prop", () => {
    expect(typeof api.removeTagFromAll).toBe("function");
    expect(api.removeTagFromAll.length).toBe(1);
    // Compile-time proof: the local call fills the shared prop with no
    // adapter. If the shapes ever diverge this render stops type-checking.
    const html = renderToString(
      <FilterBar
        tasks={[makeTask({ id: "t1", tags: ["parity-tag"] })]}
        filter={{
          status: "all",
          component: null,
          type: null,
          user: null,
          tags: [],
        }}
        onFilter={() => {}}
        onRemoveTagFromAll={api.removeTagFromAll}
      />,
    );
    // Closed dropdown: tag rows (and their Remove actions) are not rendered.
    expect(html).not.toContain("Remove parity-tag from all tasks");
  });

  it("local App passes onRemoveTagFromAll and refreshes on success (no optimistic update)", () => {
    // The exact prop the shared FilterBar gates the action on. Dropping it
    // hides every Remove button — the original bug. Tripwire, not style.
    expect(APP_TSX).toContain("onRemoveTagFromAll={handleRemoveTagFromAll}");
    // Same operation as online: one call, then a board reload. Online
    // refreshes after the mutation settles, so local must too — the reload
    // has to come AFTER the await, never before it (no optimistic strip).
    const handler = APP_TSX.slice(
      APP_TSX.indexOf("handleRemoveTagFromAll(tag: string)"),
    );
    const awaitAt = handler.indexOf("await api.removeTagFromAll(tag)");
    const reloadAt = handler.indexOf("loadTasks()");
    expect(awaitAt).toBeGreaterThan(-1);
    expect(reloadAt).toBeGreaterThan(awaitAt);
  });
});
