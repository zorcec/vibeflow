import type { ProjectAuth } from "../../../src/auth/project-auth.js";

/**
 * Shared auth shapes for unit tests (ADR-0005).
 *
 * Production resolves auth through exactly one function —
 * `resolveProjectAuth(projectDir)` — so tests that used to mock
 * `auth/token.js:readToken` + `auth/workspace.js:readWorkspace` now mock
 * this one seam instead:
 *
 *   vi.mock(".../src/auth/project-auth.js", () => ({
 *     resolveProjectAuth: vi.fn(),
 *   }));
 *   import { resolveProjectAuth } from ".../src/auth/project-auth.js";
 *   vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
 */

export const TEST_API_URL = "https://app.vibeflow.tools";

export function saasAuth(overrides: Partial<ProjectAuth> = {}): ProjectAuth {
  return {
    mode: "saas",
    unlinked: false,
    token: "test-token",
    workspaceId: "board-1",
    apiUrl: TEST_API_URL,
    projectDir: "/test-project",
    notice: null,
    ...overrides,
  };
}

export function localAuth(overrides: Partial<ProjectAuth> = {}): ProjectAuth {
  return {
    mode: "local",
    unlinked: false,
    token: null,
    workspaceId: null,
    apiUrl: TEST_API_URL,
    projectDir: "/test-project",
    notice: null,
    ...overrides,
  };
}

export function unlinkedAuth(
  overrides: Partial<ProjectAuth> = {},
): ProjectAuth {
  return {
    ...localAuth(),
    unlinked: true,
    workspaceId: "board-1",
    notice: "This project is linked to board board-1 but has no credential.",
    ...overrides,
  };
}
