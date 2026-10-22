/**
 * Online `--get` relations display (ticket 086b40aa).
 *
 * The online detail response carries parentId + children, so the CLI renders
 * relations from that ONE response — never a board listing. These are
 * pure-function tests on the formatting layer that drives that display:
 * hasSaasDetailRelations (contract detection) + formatSaasDetailRelations.
 */

import { describe, it, expect } from "vitest";
import {
  hasSaasDetailRelations,
  formatSaasDetailRelations,
} from "../../../src/core/task-links.js";

describe("online --get relations — detail response with children", () => {
  it("prints the parent line and one line per child", () => {
    const detail = {
      parentId: "parent-1234567890abcdef",
      children: [
        { id: "child-aaaa1111", title: "First child", status: "todo" },
        { id: "child-bbbb2222", title: "Second child", status: "done" },
      ],
    };
    expect(hasSaasDetailRelations(detail)).toBe(true);
    const lines = formatSaasDetailRelations(detail);

    expect(lines[0]).toBe("parent:   parent-1234567890abcdef");
    expect(lines[1]).toBe("children (2):");
    expect(lines[2]).toBe("  - child-aaaa1111 First child (todo)");
    expect(lines[3]).toBe("  - child-bbbb2222 Second child (done)");
    expect(lines).toHaveLength(4);
  });
});

describe("online --get relations — task with none", () => {
  it("prints 'children: none' and no parent line", () => {
    const detail = { parentId: null, children: [] as never[] };
    expect(hasSaasDetailRelations(detail)).toBe(true);
    const lines = formatSaasDetailRelations(detail);

    expect(lines).toEqual(["children: none"]);
  });
});

describe("online --get relations — older server predating the contract", () => {
  it("detects the missing contract so the caller prints the single unavailable line", () => {
    expect(hasSaasDetailRelations({})).toBe(false);
  });

  it("does not throw on a response with neither field", () => {
    expect(() => formatSaasDetailRelations({})).not.toThrow();
  });
});
