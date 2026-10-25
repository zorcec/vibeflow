import fs from "node:fs/promises";
import { resolve } from "node:path";
import { getApiUrl } from "../core/api-url.js";
import {
  getCredentialsPath,
  normalizeApiUrl,
  readCredential,
} from "./credentials.js";
import {
  getProjectPointerPath,
  readProjectPointer,
} from "./project-pointer.js";
import { getLegacyTokenPath } from "./token.js";

/**
 * Project-scoped auth resolution (ADR-0005).
 *
 * ONE function, used everywhere the old global `getMode()` was used:
 *
 *   explicit `--project <dir>` / positional dir (resolved by the caller)
 *     → `<project>/.vibeflow/settings.json` workspace pointer
 *       → credential for that apiUrl (+ workspaceId match)
 *         → saas; otherwise local.
 *
 * A project that declares nothing is local, even when the credential
 * store holds entries for other projects — a global credential is never
 * consulted for a pointer-less project. A pointer whose credential is
 * missing (or names a different workspace) resolves `unlinked`: the CLI
 * maps that to local-with-a-notice, the MCP server to a NOT_CONNECTED
 * refusal — never to another project's token, never to silent local.
 */

export type ProjectAuthMode = "local" | "saas";

export interface ProjectAuth {
  mode: ProjectAuthMode;
  /** Pointer present but no usable credential for it. */
  unlinked: boolean;
  token: string | null;
  workspaceId: string | null;
  /** Effective apiUrl the lookup ran against. */
  apiUrl: string;
  projectDir: string;
  /** One-line human explanation when the resolution is noteworthy. */
  notice: string | null;
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export async function resolveProjectAuth(
  projectDir: string,
  opts?: { apiUrl?: string },
): Promise<ProjectAuth> {
  const abs = resolve(projectDir);
  const apiUrl = opts?.apiUrl ?? getApiUrl();
  const base = {
    apiUrl,
    projectDir: abs,
  };
  await warnLegacyTokenOnce();
  let pointer: { apiUrl: string; id: string } | null = null;
  try {
    pointer = readProjectPointer(abs);
  } catch {
    pointer = null;
  }
  if (!pointer) {
    return {
      ...base,
      mode: "local",
      unlinked: false,
      token: null,
      workspaceId: null,
      notice: null,
    };
  }
  if (
    !isHttpUrl(pointer.apiUrl) ||
    normalizeApiUrl(pointer.apiUrl) !== normalizeApiUrl(apiUrl)
  ) {
    return {
      ...base,
      mode: "local",
      unlinked: true,
      token: null,
      workspaceId: pointer.id,
      notice:
        `This project is linked to board ${pointer.id} on ${pointer.apiUrl}, ` +
        `but the API in use is ${apiUrl} — run \`vibeflow login\` in ${abs} to link it.`,
    };
  }
  let cred: { token: string; workspaceId?: string } | null = null;
  try {
    cred = await readCredential(apiUrl);
  } catch {
    cred = null;
  }
  if (!cred || !cred.token) {
    return {
      ...base,
      mode: "local",
      unlinked: true,
      token: null,
      workspaceId: pointer.id,
      notice:
        `This project is linked to board ${pointer.id} but has no credential — ` +
        `run \`vibeflow login\` in ${abs} to link it.`,
    };
  }
  if (cred.workspaceId !== undefined && cred.workspaceId !== pointer.id) {
    return {
      ...base,
      mode: "local",
      unlinked: true,
      token: null,
      workspaceId: pointer.id,
      notice:
        `This project is linked to board ${pointer.id}, but the stored credential ` +
        `names board ${cred.workspaceId} — run \`vibeflow login\` in ${abs} to link it.`,
    };
  }
  return {
    ...base,
    mode: "saas",
    unlinked: false,
    token: cred.token,
    workspaceId: pointer.id,
    notice: null,
  };
}

// ── Legacy global token: ignored, announced once ──────────────────────────

let legacyWarned = false;

/** Test seam: re-arm the once-per-process legacy warning. */
export function resetLegacyTokenWarning(): void {
  legacyWarned = false;
}

async function warnLegacyTokenOnce(): Promise<void> {
  if (legacyWarned) return;
  legacyWarned = true;
  try {
    await fs.access(getLegacyTokenPath());
  } catch {
    return;
  }
  console.log(
    "  Legacy global token is ignored — run `vibeflow login` in this project to link it.",
  );
}

// ── mtime-checked cache (MCP long-lived servers) ───────────────────────────

interface CachedAuth {
  pointerMtime: number | null;
  credMtime: number | null;
  auth: ProjectAuth;
}

const authCache = new Map<string, CachedAuth>();

async function mtimeOrNull(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Cached `resolveProjectAuth` for long-lived servers: the project
 * pointer and the credential store are re-read only when either file's
 * mtime moved, so `vibeflow login` / `logout` take effect WITHOUT
 * restarting the MCP server — while a pinned root can never drift onto
 * another project's credential (the read is always scoped to this
 * project's pointer).
 */
export async function resolveProjectAuthCached(
  projectDir: string,
  opts?: { apiUrl?: string },
): Promise<ProjectAuth> {
  const abs = resolve(projectDir);
  const key = opts?.apiUrl !== undefined ? `${abs}\n${opts.apiUrl}` : abs;
  const cached = authCache.get(key);
  const [pointerMtime, credMtime] = await Promise.all([
    mtimeOrNull(getProjectPointerPath(abs)),
    mtimeOrNull(getCredentialsPath()),
  ]);
  if (
    cached !== undefined &&
    cached.pointerMtime === pointerMtime &&
    cached.credMtime === credMtime
  ) {
    return cached.auth;
  }
  const auth = await resolveProjectAuth(abs, opts);
  authCache.set(key, { pointerMtime, credMtime, auth });
  return auth;
}

/** Test seam: drop the mtime cache (whole map, or one project). */
export function dropProjectAuthCache(projectDir?: string): void {
  if (projectDir === undefined) {
    authCache.clear();
    return;
  }
  const abs = resolve(projectDir);
  for (const key of [...authCache.keys()]) {
    if (key === abs || key.startsWith(`${abs}\n`)) authCache.delete(key);
  }
}
