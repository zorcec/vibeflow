import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PROTO_DIR } from "../core/types.js";
import { normalizeApiUrl } from "./credentials.js";

/**
 * Project-side auth pointer (ADR-0005).
 *
 * `<project>/.vibeflow/settings.json` gains `workspace: { apiUrl, id }`
 * — committable, secret-free. It names the board this project is linked
 * to; the secret for that board's host lives user-scoped in
 * `auth/credentials.ts`. Reads and writes preserve every other key in
 * the file (it is also the local ProtoSettings store).
 */

export interface ProjectWorkspacePointer {
  apiUrl: string;
  id: string;
}

const POINTER_KEY = "workspace";

export function getProjectPointerPath(projectDir: string): string {
  return join(resolve(projectDir), PROTO_DIR, "settings.json");
}

function isPointer(value: unknown): value is ProjectWorkspacePointer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.apiUrl === "string" &&
    v.apiUrl.length > 0 &&
    typeof v.id === "string" &&
    v.id.length > 0
  );
}

function readSettingsObject(projectDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(
      readFileSync(getProjectPointerPath(projectDir), "utf-8"),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readProjectPointer(
  projectDir: string,
): ProjectWorkspacePointer | null {
  const obj = readSettingsObject(projectDir);
  const raw = obj[POINTER_KEY];
  return isPointer(raw) ? { apiUrl: raw.apiUrl, id: raw.id } : null;
}

let tmpCounter = 0;

function writeSettingsObject(
  projectDir: string,
  obj: Record<string, unknown>,
): void {
  const protoDir = join(resolve(projectDir), PROTO_DIR);
  if (!existsSync(protoDir)) mkdirSync(protoDir, { recursive: true });
  const target = getProjectPointerPath(projectDir);
  // Atomic publish beside the target (same filesystem, so the rename
  // cannot cross devices): a crash mid-write leaves the old settings.
  tmpCounter += 1;
  const tmp = `${target}.tmp.${process.pid}.${tmpCounter}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  renameSync(tmp, target);
}

export function writeProjectPointer(
  projectDir: string,
  pointer: ProjectWorkspacePointer,
): void {
  const obj = readSettingsObject(projectDir);
  obj[POINTER_KEY] = {
    apiUrl: normalizeApiUrl(pointer.apiUrl),
    id: pointer.id,
  };
  writeSettingsObject(projectDir, obj);
}

export function deleteProjectPointer(projectDir: string): boolean {
  const obj = readSettingsObject(projectDir);
  if (!(POINTER_KEY in obj)) return false;
  delete obj[POINTER_KEY];
  writeSettingsObject(projectDir, obj);
  return true;
}
