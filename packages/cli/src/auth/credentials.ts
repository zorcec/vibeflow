import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * User-scoped credential store (ADR-0005).
 *
 * `~/.vibeflow/credentials.json` (mode 0600) maps a NORMALIZED apiUrl to
 * the credential minted for it: `{ token, workspaceId, account,
 * updatedAt }`. Multiple entries coexist — one login per host, never one
 * login per machine. Nothing here names a project; the project side of
 * the link lives in the repo (`auth/project-pointer.ts`). The token is
 * never written anywhere else.
 */

export interface CredentialEntry {
  token: string;
  workspaceId?: string;
  account?: string | null;
  updatedAt: string;
}

export type CredentialMap = Record<string, CredentialEntry>;

export function getCredentialsPath(home: string = os.homedir()): string {
  return path.join(home, ".vibeflow", "credentials.json");
}

/**
 * Normalize an API base URL into its stable map key: lowercased
 * scheme + host, no trailing slash, no query/hash. Anything that is not
 * an http(s) URL falls back to the trimmed raw string — callers that
 * need the SSRF guard validate separately (the resolution layer does).
 */
export function normalizeApiUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return trimmed.replace(/\/+$/, "");
    }
    const p = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${p === "/" ? "" : p}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function isEntry(value: unknown): value is CredentialEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.token === "string" && v.token.length > 0;
}

export async function readCredentials(): Promise<CredentialMap> {
  try {
    const raw = await fs.readFile(getCredentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: CredentialMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isEntry(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export async function readCredential(
  apiUrl: string,
): Promise<CredentialEntry | null> {
  const all = await readCredentials();
  return all[normalizeApiUrl(apiUrl)] ?? null;
}

let tmpCounter = 0;

/**
 * Atomic, 0600-preserving write: the entry lands in a temp file beside
 * the target and is renamed over it, so a crash mid-write can never
 * leave a truncated credentials file (rename is atomic; the temp file
 * carries the restrictive mode from creation).
 */
async function writeCredentialsAtomic(all: CredentialMap): Promise<void> {
  const target = getCredentialsPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  tmpCounter += 1;
  const tmp = `${target}.tmp.${process.pid}.${tmpCounter}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(all, null, 2), {
      mode: 0o600,
    });
    await fs.rename(tmp, target);
    await fs.chmod(target, 0o600);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function writeCredential(
  apiUrl: string,
  entry: { token: string; workspaceId?: string; account?: string | null },
): Promise<void> {
  const all = await readCredentials();
  all[normalizeApiUrl(apiUrl)] = {
    token: entry.token,
    ...(entry.workspaceId !== undefined
      ? { workspaceId: entry.workspaceId }
      : {}),
    account: entry.account ?? null,
    updatedAt: new Date().toISOString(),
  };
  await writeCredentialsAtomic(all);
}

export async function deleteCredential(apiUrl: string): Promise<boolean> {
  const all = await readCredentials();
  const key = normalizeApiUrl(apiUrl);
  if (!(key in all)) return false;
  delete all[key];
  await writeCredentialsAtomic(all);
  return true;
}
