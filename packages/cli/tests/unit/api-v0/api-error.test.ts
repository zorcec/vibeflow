/**
 * The shared refusal envelope (ticket 0045949e phase 1).
 *
 * One builder for both API surfaces: `error` is the human sentence, `code`
 * the machine token, `details` the structured hints. The hosted v0 routes
 * already answer this layout, so a client written against one surface reads
 * the other unchanged — that is the property these assertions pin.
 */
import { describe, it, expect } from "vitest";
import { apiError } from "@vibeflow-tools/api-core";

describe("apiError", () => {
  it("carries the human sentence in `error` and the machine token in `code`", () => {
    const refusal = apiError(404, "NOT_FOUND", "Task not found");

    expect(refusal.status).toBe(404);
    expect(refusal.body).toEqual({
      error: "Task not found",
      code: "NOT_FOUND",
    });
  });

  it("omits `details` entirely when the caller has none", () => {
    const refusal = apiError(403, "FORBIDDEN", "Forbidden");

    // Not `details: undefined`: a plain refusal must be byte-identical to the
    // hosted answer for the same refusal, and `JSON.stringify` drops nothing.
    expect(Object.keys(refusal.body).sort()).toEqual(["code", "error"]);
    expect(JSON.stringify(refusal.body)).toBe(
      '{"error":"Forbidden","code":"FORBIDDEN"}',
    );
  });

  it("folds format hints into `details` instead of extra top-level keys", () => {
    const refusal = apiError(400, "INVALID_WAIT", "`wait` must be a whole number of milliseconds", {
      expectedFormat: "<milliseconds, digits only>",
      example: "wait=20000",
    });

    expect(refusal.body).toEqual({
      error: "`wait` must be a whole number of milliseconds",
      code: "INVALID_WAIT",
      details: {
        expectedFormat: "<milliseconds, digits only>",
        example: "wait=20000",
      },
    });
  });
});
