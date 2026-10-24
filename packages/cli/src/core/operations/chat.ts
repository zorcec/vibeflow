/**
 * Agent-chat page-read operations (ticket 453c7465, P7 chat increment).
 *
 * The classified wrappers behind the chat-only `read_page_text` and
 * `read_page_dom` tools (`src/server/agent-chat/mcp.ts`). Chat-only means
 * exactly that: neither surface the main MCP manifest nor the CLI exposes
 * exists here — the registry rows carry empty `cli`/`mcpTools` on purpose,
 * and no CLI command or general task-operation exemption is added.
 * `server/chat` stays the only caller; the approval gate stays where it
 * is (`makeGatedRunner` runs these read-only tools free, exactly as the
 * inline dispatch did).
 *
 * Both operations are thin by design: every policy — the bounded fetch,
 * the per-hop SSRF block, the byte/char caps, the `<untrusted-webpage>`
 * wrapping, the browser-tab DOM round-trip with its deterministic
 * TIMEOUT/ELEMENT_NOT_FOUND refusals — lives in the injected `run` port
 * (the real `runReadPageText`/`runReadPageDom` in production, fakes in
 * tests). The operation owns only the classified identity the registry
 * pins: WHAT runs (a read-only page read, never a board write) and with
 * which threading (the DOM read is scoped to its chat `sessionId`).
 * Results — including refusals — pass through verbatim, so the wire
 * shape the chat MCP server returns is byte-identical to the inline
 * dispatch it replaces.
 */
import type { OperationContext } from "../operations.js";
import type { ChatMcpTextResult } from "../../server/agent-chat/mcp.js";

// ── readPageText ─────────────────────────────────────────────────────────

/** What a page-text read needs, minus the module identity (injected). */
export type ReadPageTextRunner = (
  input: unknown,
  fetchImpl?: typeof fetch,
  resolveHost?: (hostname: string) => Promise<string[]>,
) => Promise<ChatMcpTextResult>;

export interface ReadPageTextInput {
  /**
   * Raw tool input, forwarded verbatim to the runner (the runner owns
   * URL validation and answers non-http(s) input with INVALID_URL).
   */
  input: unknown;
  /**
   * Runs the read. Required (not defaulted): the chat dispatcher passes
   * its statically imported `runReadPageText` — the same seam discipline
   * as `startServer`'s injected `serve` — and unit tests pass fakes that
   * assert the exact args, so no test ever performs a real fetch.
   */
  run: ReadPageTextRunner;
  /** Fetch implementation the runner uses (a fake in tests). */
  fetchImpl?: typeof fetch;
  /** DNS resolver the runner's SSRF guard uses (a fake in tests). */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export async function readPageText(
  _ctx: OperationContext,
  input: ReadPageTextInput,
): Promise<ChatMcpTextResult> {
  return input.run(input.input, input.fetchImpl, input.resolveHost);
}

// ── readPageDom ──────────────────────────────────────────────────────────

/** The live-tab answer the DOM read round-trips for. */
export type BrowserDomAnswer = { text: string; found: boolean } | null;

/** Asks the session's browser tab for its live DOM text. */
export type RequestBrowserDomFn = (
  sessionId: string,
  selector?: string,
) => Promise<BrowserDomAnswer>;

/** What a live-DOM read needs, minus the module identity (injected). */
export type ReadPageDomRunner = (
  sessionId: string,
  input: unknown,
  requestDom: RequestBrowserDomFn,
) => Promise<ChatMcpTextResult>;

export interface ReadPageDomInput {
  /** Chat session whose tab answers the DOM round-trip. */
  sessionId: string;
  /**
   * Raw tool input, forwarded verbatim to the runner (the runner owns
   * selector handling and answers a selector miss with
   * ELEMENT_NOT_FOUND, a silent tab with TIMEOUT).
   */
  input: unknown;
  /**
   * Runs the read. Required (not defaulted): same seam discipline as
   * `readPageText` — the dispatcher passes `runReadPageDom`, tests pass
   * fakes, no test ever touches a real browser tab.
   */
  run: ReadPageDomRunner;
  /** Browser-tab round-trip hook for this session (a fake in tests). */
  requestDom: RequestBrowserDomFn;
}

export async function readPageDom(
  _ctx: OperationContext,
  input: ReadPageDomInput,
): Promise<ChatMcpTextResult> {
  return input.run(input.sessionId, input.input, input.requestDom);
}
