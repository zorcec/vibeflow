import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import type { ProtoConfig } from "./types.js";
import { PROTO_DIR, CONFIG_FILE } from "./types.js";

const DEFAULT_CONFIG: ProtoConfig = {
  port: 3700,
};

export function getConfigPath(projectDir: string): string {
  return join(projectDir, PROTO_DIR, CONFIG_FILE);
}

export function hasProtoDir(projectDir: string): boolean {
  return existsSync(join(projectDir, PROTO_DIR));
}

export function ensureProtoDir(projectDir: string): void {
  mkdirSync(join(projectDir, PROTO_DIR), { recursive: true });
}

export function readConfig(projectDir: string): ProtoConfig {
  const configPath = getConfigPath(projectDir);
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };

  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<ProtoConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
  };
}

export function writeConfig(
  projectDir: string,
  config: ProtoConfig,
): void {
  ensureProtoDir(projectDir);
  const configPath = getConfigPath(projectDir);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Resolves the human-readable project name: prefers package.json "name" field,
 * falls back to the directory name. Shared between REST and tRPC endpoints.
 */
export function getProjectName(projectDir: string): string {
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
      if (pkg.name) return pkg.name;
    } catch { /* fall through */ }
  }
  return basename(projectDir);
}

/**
 * Returns the current git branch name, or null if not in a git repo.
 */
export function getCurrentBranch(projectDir: string): string | null {
  try {
    const branch = execSync("git branch --show-current", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}
