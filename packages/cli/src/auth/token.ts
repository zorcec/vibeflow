import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Retired machine-global token path (ADR-0005).
 *
 * `~/.vibeflow/token` is NO LONGER READ — mode resolves per project
 * from the repo pointer (`auth/project-pointer.ts`) plus the
 * user-scoped store (`auth/credentials.ts`). These helpers exist only
 * so the resolver can notice a leftover file and print the one-line
 * "legacy token ignored" notice. Nothing writes here anymore.
 */

export function getLegacyTokenPath(): string {
  return path.join(os.homedir(), ".vibeflow", "token");
}

export async function legacyTokenPresent(): Promise<boolean> {
  try {
    await fs.access(getLegacyTokenPath());
    return true;
  } catch {
    return false;
  }
}
