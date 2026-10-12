// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  OVERLAY_SCRIPT_ATTR,
  LEGACY_OVERLAY_SCRIPT_ATTR,
  OVERLAY_ROOT_ID,
  LEGACY_OVERLAY_ROOT_ID,
  findOverlayScript,
  isOverlayActive,
  readBoardIdGlobal,
} from "../../src/client/overlay-attributes.js";

describe("overlay-attributes", () => {
  it("emits only the new names", () => {
    expect(OVERLAY_SCRIPT_ATTR).toBe("data-vibeflow-overlay");
    expect(OVERLAY_ROOT_ID).toBe("vibeflow-studio-root");
  });

  it("prefers data-board-id over every other match (regression)", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const decoy = document.createElement("script");
    decoy.setAttribute("src", "http://localhost:3700/proto-overlay.js");
    decoy.setAttribute(LEGACY_OVERLAY_SCRIPT_ATTR, "");
    document.head.appendChild(decoy);
    const real = document.createElement("script");
    real.setAttribute("src", "/api/overlay.js");
    real.setAttribute("data-board-id", "ws-1");
    document.head.appendChild(real);

    expect(findOverlayScript(document)).toBe(real);
  });

  it("still detects legacy data-proto-overlay embeds", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const legacy = document.createElement("script");
    legacy.setAttribute("src", "https://example.com/overlay.js");
    legacy.setAttribute(LEGACY_OVERLAY_SCRIPT_ATTR, "");
    legacy.setAttribute("data-board-id", "ws-legacy");
    document.head.appendChild(legacy);

    const found = findOverlayScript(document);
    expect(found).toBe(legacy);
  });

  it("finds the new overlay marker without a board id", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const s = document.createElement("script");
    s.setAttribute("src", "http://localhost:3700/vibeflow-overlay.js");
    s.setAttribute(OVERLAY_SCRIPT_ATTR, "");
    document.head.appendChild(s);

    expect(findOverlayScript(document)).toBe(s);
  });

  it("treats both root ids as already-active", () => {
    document.body.innerHTML = "";
    expect(isOverlayActive(document)).toBe(false);
    const fresh = document.createElement("div");
    fresh.id = OVERLAY_ROOT_ID;
    document.body.appendChild(fresh);
    expect(isOverlayActive(document)).toBe(true);
    document.body.innerHTML = "";
    const legacy = document.createElement("div");
    legacy.id = LEGACY_OVERLAY_ROOT_ID;
    document.body.appendChild(legacy);
    expect(isOverlayActive(document)).toBe(true);
    document.body.innerHTML = "";
  });

  it("reads the new board-id global first, legacy second", () => {
    expect(readBoardIdGlobal({})).toBeUndefined();
    expect(
      readBoardIdGlobal({ __PROTO_BOARD_ID: "legacy-board" }),
    ).toBe("legacy-board");
    expect(
      readBoardIdGlobal({
        __VIBEFLOW_BOARD_ID: "new-board",
        __PROTO_BOARD_ID: "legacy-board",
      }),
    ).toBe("new-board");
  });
});
