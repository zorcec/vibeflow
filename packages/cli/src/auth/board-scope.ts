/**
 * Board scope resolution for every CLI v0 request (ticket dabd2fb7).
 *
 * The server addresses cloud requests by board: a one-board account gets
 * an implicit default, a 2+ board account answers 422 SCOPE_REQUIRED
 * unless X-Vibeflow-Scope names the board (packages/api-core/src/principal.ts,
 * resolveBoardScopeFromSnapshot in the web server). The CLI therefore needs
 * ONE rule everyone shares — this module:
 *
 *   (a) explicit --board flag
 *   (b) saved ~/.vibeflow/workspace (written by `auth login`)
 *   (c) auto-select ONLY when the account has exactly one board
 *
 * A 2+ board account with nothing selected NEVER gets a guess: a wrong-board
 * push moves the whole store (1753 tasks) to the wrong place, so the
 * resolution throws BoardScopeRequiredError and the command reports the
 * board list plus the exact retry command before any request is sent.
 */

import chalk from "chalk";
import { getApiUrl, surfacePath } from "../core/api-url.js";
import { fetchWithTimeout } from "../saas/request.js";
import { readToken } from "./token.js";
import { readWorkspace } from "./workspace.js";

export interface BoardSummary {
  id: string;
  name: string;
  icon?: string | null;
}

/**
 * Raised when an account has 2+ boards and neither --board nor a saved
 * workspace names one. Carries the board list so every surface (human
 * report, JSON envelope, push notice) can print the same facts.
 */
export class BoardScopeRequiredError extends Error {
  readonly code = "SCOPE_REQUIRED";
  readonly boards: BoardSummary[];
  constructor(boards: BoardSummary[]) {
    const ids = boards.map((b) => b.id).join(", ");
    const example = boards[0]?.id ?? "<boardId>";
    super(
      [
        `This account has ${boards.length} boards and none is selected:`,
        ...boards.map((b) => `  ${b.id}  ${b.name}`),
        "Re-run your command with --board <boardId> " +
          `(e.g. \`vibeflow push --board ${example}\`), or run \`vibeflow auth login\` to bind a default board. ` +
          `Boards: ${ids}`,
      ].join("\n"),
    );
    this.name = "BoardScopeRequiredError";
    this.boards = boards;
  }
}

/**
 * X-Vibeflow-Scope is THE board-addressing mechanism (the v0 contract has no
 * board query parameter) — every request builder in the CLI must use this
 * one helper, never a second spelling.
 */
export function scopeHeaderFor(
  boardId: string | undefined | null,
): Record<string, string> {
  return boardId ? { "X-Vibeflow-Scope": boardId } : {};
}

/** Test seams: replace the token probe, workspace read, and board listing. */
export interface BoardScopeDeps {
  hasToken?: () => Promise<boolean>;
  readSavedBoard?: () => Promise<{ id: string } | null>;
  listBoards?: () => Promise<BoardSummary[]>;
}

/**
 * Default board listing: the same endpoint `auth login` paginates
 * (`GET /api/v0/boards`, bounded to 50 pages like login). Any failure
 * throws — callers decide whether that is fatal or falls back to the
 * server's own authoritative 403/422.
 */
async function fetchBoardSummaries(): Promise<BoardSummary[]> {
  const token = await readToken();
  if (!token) return [];
  const headers = { Authorization: `Bearer ${token}` };
  const base = `${getApiUrl()}${surfacePath("cloud", "/api/cli/workspaces")}`;
  const out: BoardSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const url = new URL(base);
    if (cursor) url.searchParams.set("cursor", cursor);
    // SAFETY: base is getApiUrl() (validates http(s), falls back to the
    // production default — the repo's SSRF/credential-leak guard) plus a
    // constant path; cursor is appended as a query param, never a host.
    // pi-lens-ignore: ts-ssrf — base validated by getApiUrl()
    const res = await fetchWithTimeout(url.toString(), { headers }, { phase: "board-resolution" });
    if (!res.ok) throw new Error(`board listing failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      items?: unknown;
      workspaces?: unknown;
      nextCursor?: unknown;
    };
    const rows = Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.workspaces)
        ? body.workspaces
        : [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      if (typeof r.id !== "string" || r.id.length === 0) continue;
      out.push({
        id: r.id,
        name: typeof r.name === "string" && r.name ? r.name : r.id,
        icon: typeof r.icon === "string" ? r.icon : null,
      });
    }
    cursor =
      typeof body.nextCursor === "string" && body.nextCursor.length > 0
        ? body.nextCursor
        : null;
    if (!cursor) break;
  }
  return out;
}

/**
 * Resolve the board id for a command: (a) explicit flag, (b) saved
 * workspace, (c) single-board auto-select; throws BoardScopeRequiredError
 * on 2+ boards with nothing selected. Returns null when no board is known
 * (no token → local mode is unchanged; board listing unreachable → the
 * server stays the authority and answers with its own 403/422).
 */
export async function resolveBoardScope(
  flagBoard?: string | null,
  deps?: BoardScopeDeps,
): Promise<string | null> {
  if (typeof flagBoard === "string" && flagBoard.trim() !== "") {
    return flagBoard.trim();
  }
  const saved = await (deps?.readSavedBoard ?? readWorkspace)();
  if (saved?.id) return saved.id;
  const hasToken = deps?.hasToken ?? (async () => (await readToken()) !== null);
  if (!(await hasToken())) return null;
  const listBoards = deps?.listBoards ?? fetchBoardSummaries;
  let boards: BoardSummary[];
  try {
    boards = await listBoards();
  } catch {
    // Transient listing failure is NOT a scope refusal — proceed unscoped
    // and let the server answer authoritatively (same as before this
    // module existed).
    return null;
  }
  if (boards.length === 1) return boards[0]!.id;
  if (boards.length > 1) throw new BoardScopeRequiredError(boards);
  return null;
}

/**
 * Cheap scope peek for request builders (saas/client.ts): returns the saved
 * workspace id and NOTHING else — no token read, no network. Command
 * entries (tasks/push) call resolveBoardScope first, so auto-selection
 * and the 2+ board refusal happen before any request; a lazy peek that finds
 * nothing simply sends no header and the server's 422 remains authoritative.
 */
export async function peekBoardScope(): Promise<string | null> {
  try {
    const saved = await readWorkspace();
    return saved?.id ?? null;
  } catch {
    return null;
  }
}

/** Human report for a BoardScopeRequiredError: red headline, dim details. */
export function printBoardScopeRequired(err: BoardScopeRequiredError): void {
  const [head, ...rest] = err.message.split("\n");
  console.error(chalk.red(`✗ ${head}`));
  for (const line of rest) console.error(chalk.dim(`  ${line.trim()}`));
}

/**
 * Scope headers for the CURRENTLY SAVED board, resolved per call.
 *
 * WHY per call and not once at startup: `auth login` writes the board and then
 * pushes in the SAME process, so a value cached at import time would be null
 * exactly when it is needed. The cost is one small file read per request.
 *
 * This is what makes task create, file upload and link apply work on a 2-board
 * account: the server answers 422 SCOPE_REQUIRED for any of them without
 * X-Vibeflow-Scope (measured: 1758/1758 tasks and 782 files refused).
 */
export async function scopeHeadersFromSaved(): Promise<Record<string, string>> {
  return scopeHeaderFor(await peekBoardScope());
}
