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
