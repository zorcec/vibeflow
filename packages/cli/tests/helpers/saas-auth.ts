/**
 * Shared SaaS-mode fixture (ADR-0005).
 *
 * Project-scoped auth replaced the machine-global `~/.vibeflow/token`:
 * a legacy token file is IGNORED, so a test that wants the CLI to take
 * the online branch must write BOTH halves of the link, mirroring exactly
 * what `resolveProjectAuth` reads:
 * - user-scoped `~/.vibeflow/credentials.json` (mode 0600) keyed by the
 *   NORMALIZED apiUrl → `{ token, workspaceId, account, updatedAt }`;
 * - project-side `<store>/.vibeflow/settings.json` pointer
 *   `workspace: { apiUrl, id }` (merged, never clobbering other keys).
 *
 * The credential key and the pointer apiUrl both go through the
 * production `normalizeApiUrl`, so the fixture cannot drift from the
 * resolver. `workspaceId` defaults to `board-1` (the board id the fake
 * backends below serve); the fixture names the same board on both halves
 * by default. A credential whose `workspaceId` differs from a project's
 * pointer still resolves `saas` on the pointer's board (the pointer picks
 * the board; the credential only proves identity) — see
 * `tests/unit/auth/project-auth.test.ts` for the multi-board pin.
 *
 * This is the ONE implementation — the copies that lived in
 * `auth-online-flow.test.ts` (`seedCredential`/`seedPointer`) and
 * `auth-device-reuse.test.ts` (inline credentials.json write) were folded
 * in here. Test setup uses temp HOMEs only; never the operator's real HOME.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { normalizeApiUrl } from "../../src/auth/credentials.js";

export interface SaaSModeOptions {
  /** Caller-owned temp dir — becomes the CLI child's HOME. */
  home: string;
  /** Project dir the CLI runs against (receives the board pointer). */
  store: string;
  /** API base the CLI is aimed at (e.g. the stub URL via VIBEFLOW_API_URL). */
  apiUrl: string;
  /** Bearer token the fake backend expects. Defaults to `"test-token"`. */
  token?: string;
  /** Board id for both the pointer and the credential. Defaults to `"board-1"`. */
  workspaceId?: string;
  /** Account label stored beside the token (never asserted, for realism). */
  account?: string;
}

/**
 * Write the credential store entry plus the project pointer so the CLI
 * resolves `saas` for `store` against `apiUrl`. Merges with whatever is
 * already in either file (project settings keys like `autoCommit` survive).
 */
export function setupSaaSMode(opts: SaaSModeOptions): void {
  const { home, store, apiUrl } = opts;
  const token = opts.token ?? "test-token";
  const workspaceId = opts.workspaceId ?? "board-1";
  const account = opts.account ?? "e2e@example.com";
  const key = normalizeApiUrl(apiUrl);

  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  const credPath = join(home, ".vibeflow", "credentials.json");
  let all: Record<string, unknown> = {};
  if (existsSync(credPath)) {
    all = JSON.parse(readFileSync(credPath, "utf-8")) as Record<string, unknown>;
  }
  all[key] = {
    token,
    workspaceId,
    account,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(credPath, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(credPath, 0o600);

  mkdirSync(join(store, ".vibeflow"), { recursive: true });
  const pointerPath = join(store, ".vibeflow", "settings.json");
  let prev: Record<string, unknown> = {};
  if (existsSync(pointerPath)) {
    prev = JSON.parse(readFileSync(pointerPath, "utf-8")) as Record<string, unknown>;
  }
  writeFileSync(
    pointerPath,
    JSON.stringify({ ...prev, workspace: { apiUrl: key, id: workspaceId } }),
    "utf-8",
  );
}
