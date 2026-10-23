/**
 * ONE id rule (ticket d7b9dc13, parent e7482da5).
 *
 * Exact id wins first (an exact id that is also a prefix of others still
 * resolves to itself), then a unique prefix, then refusal. Ambiguity and
 * unknown values are refusals with codes the CLI maps to exits — never a
 * silent first-match, so no flag or tool can attach to, read, or mutate a
 * task the caller did not name.
 *
 * This lived in `saas/client.ts` (which re-exports it unchanged), but the
 * rule is backend-neutral: the CLI's local flags, the local `TaskStore`
 * port, and the remote read adapter all resolve through it. It stays here
 * — a dependency-free module — so the file-backed ports can share it
 * without importing the remote HTTP client, and the remote adapter can
 * share it without importing the file-backed store. One spelling, one
 * implementation, every surface.
 */
export type SaasIdResolution =
  | { ok: true; id: string }
  | { ok: false; code: "TASK_NOT_FOUND"; message: string }
  | {
      ok: false;
      code: "E_AMBIGUOUS";
      message: string;
      candidates: string[];
    };

export function resolveSaasTaskId(
  tasks: Array<{ id: string; title?: string | null }>,
  raw: string,
): SaasIdResolution {
  if (raw.length === 0) {
    return {
      ok: false,
      code: "TASK_NOT_FOUND",
      message: `Task not found: ${raw}`,
    };
  }
  const exact = tasks.find((t) => t.id === raw);
  if (exact) return { ok: true, id: exact.id };
  const matches = tasks.filter((t) => t.id.startsWith(raw));
  if (matches.length === 0) {
    return {
      ok: false,
      code: "TASK_NOT_FOUND",
      message: `Task not found: ${raw}`,
    };
  }
  if (matches.length === 1) return { ok: true, id: matches[0].id };
  const named = matches
    .map((m) => (m.title ? `${m.id} "${m.title}"` : m.id))
    .join(", ");
  return {
    ok: false,
    code: "E_AMBIGUOUS",
    message: `Ambiguous task id prefix "${raw}" matches ${matches.length} tasks: ${named}`,
    candidates: matches.map((m) => m.id),
  };
}
