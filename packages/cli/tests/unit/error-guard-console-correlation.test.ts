import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { guardPage } from "../playwright/error-guard";

/**
 * Console/request CORRELATION in the error guard.
 *
 * Why this exists: a resource-load failure shows up TWICE — as a failed
 * request (which carries the URL) and as a `console.error` whose text does NOT
 * carry it. Allow-listing only the request therefore still fails the suite,
 * and the tempting fix (allow-listing the text) is a blanket hole: any 404 in
 * the file would pass. These tests pin the correlation that avoids both.
 *
 * The guard only needs `page.on(event, handler)`, so these use a minimal
 * EventEmitter page — no browser required.
 */

type FakePage = EventEmitter;

function fakePage(): FakePage {
  return new EventEmitter();
}

function emitConsole(page: FakePage, text: string, url: string): void {
  page.emit("console", {
    type: () => "error",
    text: () => text,
    location: () => ({ url }),
  });
}

function emitResponse(page: FakePage, status: number, url: string): void {
  page.emit("response", {
    status: () => status,
    url: () => url,
    request: () => ({ method: () => "GET" }),
  });
}

const RESOURCE_404 =
  "Failed to load resource: the server responded with a status of 404 (Not Found)";

/** Example pin: one image URL, URL-scoped, with a named reason. (Not a
 * product allowance — the removed-file pin that used to live here left with
 * the ticket-17d42681 fix; a pinned allowance after a fix is a lie.) */
const OPTIONS = {
  allowedFailedRequests: {
    exampleImage404: {
      urlPattern: "/files/example-image.png",
      status: 404,
      reason: "example pin exercising the request/console correlation",
    },
  },
};

describe("error guard — console error / failed request correlation", () => {
  it("allows the resource-load console error that belongs to an allow-listed URL", () => {
    const page = fakePage();
    const guard = guardPage(page as never, OPTIONS);
    const url = "http://localhost:1/api/tasks/abc/files/example-image.png";

    emitResponse(page, 404, url);
    emitConsole(page, RESOURCE_404, url);

    // Both the request and its console echo are pinned by the ONE URL-scoped
    // entry — no second, broader pattern is needed.
    expect(() => guard.assertNoErrors()).not.toThrow();
  });

  it("still fails a 404 console error for a URL that is NOT allow-listed", () => {
    const page = fakePage();
    const guard = guardPage(page as never, OPTIONS);
    const url = "http://localhost:1/api/tasks/abc/files/some-other.png";

    emitResponse(page, 404, url);
    emitConsole(page, RESOURCE_404, url);

    // Non-vacuity: the correlation is scoped to the pinned URL, so an
    // unrelated 404 in the same file must still fail the test.
    expect(() => guard.assertNoErrors()).toThrow(/some-other\.png/);
  });

  it("does not mask an app-level console error merely logged at a pinned URL", () => {
    const page = fakePage();
    const guard = guardPage(page as never, OPTIONS);

    emitConsole(
      page,
      "TypeError: cannot read properties of undefined (reading 'files')",
      "http://localhost:1/api/tasks/abc/files/example-image.png",
    );

    // Only "Failed to load resource" echoes are correlated. A real JS error
    // that happens to sit at that URL is still a failure.
    expect(() => guard.assertNoErrors()).toThrow(/TypeError/);
  });
});
