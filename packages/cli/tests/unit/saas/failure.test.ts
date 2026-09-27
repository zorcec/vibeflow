/**
 * `saasFailure` — the mapping from a failed SaaS result to the refusal a
 * `--json` consumer earns.
 *
 * Tested directly because the alternative is unreachable in practice: every
 * production path to this function needs a live online board, which is exactly
 * why the mapping went untested while the codes it feeds were documented. The
 * 401/403 cases are the ones that matter — SaaS mode is selected BECAUSE a
 * token file exists, so the client's literal `NOT_AUTHENTICATED` (no token at
 * all) is the rare case, and an expired or revoked token surfacing as an HTTP
 * rejection used to be labelled `E_BACKEND_UNAVAILABLE`, i.e. "the backend is
 * down, maybe retry".
 */
import { describe, it, expect } from "vitest";
import { saasFailure } from "../../../src/saas/failure.js";

describe("saasFailure", () => {
  it("401 — the session was rejected: not retryable, and login is the fix", () => {
    expect(saasFailure({ code: "HTTP_ERROR", status: 401 })).toEqual({
      code: "E_NOT_AUTHENTICATED",
      retryable: false,
      suggestion: "Run 'vibeflow login' and retry.",
    });
  });

  it("403 — the session was rejected: not retryable, and login is the fix", () => {
    expect(saasFailure({ code: "HTTP_ERROR", status: 403 })).toEqual({
      code: "E_NOT_AUTHENTICATED",
      retryable: false,
      suggestion: "Run 'vibeflow login' and retry.",
    });
  });

  it("no token at all still maps to E_NOT_AUTHENTICATED", () => {
    expect(saasFailure({ code: "NOT_AUTHENTICATED" }).code).toBe(
      "E_NOT_AUTHENTICATED",
    );
  });

  it("NETWORK_ERROR — the host was unreachable: worth retrying", () => {
    expect(saasFailure({ code: "NETWORK_ERROR" })).toEqual({
      code: "E_BACKEND_UNAVAILABLE",
      retryable: true,
    });
  });

  it("HTTP 500 — the host answered but failed: retrying gains nothing", () => {
    expect(saasFailure({ code: "HTTP_ERROR", status: 500 })).toEqual({
      code: "E_BACKEND_UNAVAILABLE",
      retryable: false,
    });
  });

  it("HTTP 404 stays a backend failure, NOT an auth failure", () => {
    // Guards the widening: only 401/403 mean "log in again". Anything else
    // must not borrow the auth code, or a missing board looks like a session
    // problem and the consumer sends the user to the wrong fix.
    expect(saasFailure({ code: "HTTP_ERROR", status: 404 }).code).toBe(
      "E_BACKEND_UNAVAILABLE",
    );
  });
});
