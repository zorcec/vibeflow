import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { buildOverlayLoader } from "../../../src/server/overlay-loader.js";

afterEach(() => vi.useRealTimers());

describe("overlay-loader startup watchdog", () => {
  it("shows a CSP diagnostic when a script loads without initialising the overlay", () => {
    vi.useFakeTimers();
    const dom = new JSDOM("<html><head></head><body></body></html>", { runScripts: "outside-only" });
    dom.window.setTimeout = setTimeout as unknown as typeof dom.window.setTimeout;
    dom.window.setInterval = setInterval as unknown as typeof dom.window.setInterval;
    dom.window.clearTimeout = clearTimeout as unknown as typeof dom.window.clearTimeout;
    dom.window.clearInterval = clearInterval as unknown as typeof dom.window.clearInterval;
    const error = vi.spyOn(dom.window.console, "error").mockImplementation(() => {});
    dom.window.eval(buildOverlayLoader("https://overlay.test/overlay.js", "board-1"));
    vi.advanceTimersByTime(10_000);
    expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toContain("Content-Security-Policy (CSP)");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("browser extension"));
    dom.window.close();
  });
});
