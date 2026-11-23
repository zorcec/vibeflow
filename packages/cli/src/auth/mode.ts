import { resolveProjectAuth } from "./project-auth.js";

export type Mode = "local" | "saas";

/**
 * Project-scoped mode (ADR-0005): the resolved project dir is REQUIRED —
 * there are no ambient global reads. A project that declares no
 * workspace pointer is local, even with credentials stored for others.
 */
export async function getMode(projectDir: string): Promise<Mode> {
  return (await resolveProjectAuth(projectDir)).mode;
}

/**
 * The backend ONE invocation runs against, or the refusal (ADR-0005).
 *
 * `getMode()` answers only the backend, and an "unlinked" project — a pointer
 * naming a board whose credential cannot be resolved — folds into "local"
 * there. For the MCP server that is fine (it refuses the state on its own,
 * `mcp/server.ts` NOT_CONNECTED), but a CLI command that trusted the mode
 * alone took the LOCAL branch: `tasks --add` printed `✓ Task created` with a
 * locally-minted id and wrote a local file for a project that declares itself
 * online, so the success named a task the user's board never received
 * (ticket 73cb9048).
 *
 * ADR-0005 is explicit — "a pointer without a credential refuses, never
 * silent local" — so this resolves the SAME auth once per invocation and
 * refuses before any branch runs. A project with NO pointer is untouched:
 * that is local mode, not a refused link.
 */
export type CommandAccess =
  | { ok: true; mode: Mode; projectDir: string }
  | {
      ok: false;
      code: "NOT_CONNECTED";
      message: string;
      suggestion: string;
    };

export async function resolveCommandAccess(
  projectDir: string,
): Promise<CommandAccess> {
  const auth = await resolveProjectAuth(projectDir);
  if (!auth.unlinked) {
    return { ok: true, mode: auth.mode, projectDir: auth.projectDir };
  }
  const boardId = auth.workspaceId ?? "(unknown)";
  return {
    ok: false,
    code: "NOT_CONNECTED",
    // The resolver already distinguished the two causes (a pointer on a
    // different apiUrl vs a pointer with no credential) and named the login
    // remedy — reusing its sentence keeps ONE spelling of the state.
    message:
      auth.notice ??
      `This project is linked to board ${boardId} but its credential could not be resolved — run \`vibeflow login\` in ${auth.projectDir} to link it.`,
    suggestion: `Run \`vibeflow login --project ${auth.projectDir}\` to link this project, or \`vibeflow auth logout --unlink\` in it to drop the board pointer and work locally.`,
  };
}
