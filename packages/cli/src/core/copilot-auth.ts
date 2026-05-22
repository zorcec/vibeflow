/**
 * GitHub Copilot authentication module.
 *
 * Resolution order (first that succeeds wins):
 *  1. GITHUB_TOKEN environment variable
 *  2. Token stored in .proto/config.json under "copilotToken"
 *  3. `gh auth token` from the GitHub CLI (if installed)
 *
 * For interactive login: delegates to `gh auth login` if available,
 * or prompts the user to authenticate via GitHub device flow.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROTO_DIR } from "./types.js";

const CONFIG_FILE = "config.json";

export interface CopilotAuthStatus {
  authenticated: boolean;
  source: "env" | "config" | "gh-cli" | null;
  /** Masked token for display (e.g. "ghs_abc...xyz") */
  tokenHint: string | null;
  username: string | null;
}

function getConfigPath(projectDir: string): string {
  return join(projectDir, PROTO_DIR, CONFIG_FILE);
}

function readProtoConfig(projectDir: string): Record<string, unknown> {
  const path = getConfigPath(projectDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeProtoConfig(projectDir: string, config: Record<string, unknown>): void {
  const protoDir = join(projectDir, PROTO_DIR);
  mkdirSync(protoDir, { recursive: true });
  writeFileSync(getConfigPath(projectDir), JSON.stringify(config, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
}

function maskToken(token: string): string {
  if (token.length <= 8) return "***";
  return token.slice(0, 6) + "..." + token.slice(-4);
}

/** Try to get a GitHub token from the `gh` CLI. Returns null if not available. */
function getGhCliToken(): string | null {
  try {
    const token = execSync("gh auth token --hostname github.com", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

/** Get the GitHub username for a token (via API). Returns null on failure. */
async function getGitHubUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "proto-studio-cli",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { login?: string };
    return data.login ?? null;
  } catch {
    return null;
  }
}

/** Returns the authentication token and its source, or null if not authenticated. */
export function resolveCopilotToken(projectDir: string): {
  token: string;
  source: "env" | "config" | "gh-cli";
} | null {
  // 1. Environment variable
  const envToken = process.env["GITHUB_TOKEN"];
  if (envToken?.trim()) return { token: envToken.trim(), source: "env" };

  // 2. Stored in .proto/config.json
  const config = readProtoConfig(projectDir);
  const configToken = config["copilotToken"];
  if (typeof configToken === "string" && configToken.trim()) {
    return { token: configToken.trim(), source: "config" };
  }

  // 3. GitHub CLI
  const ghToken = getGhCliToken();
  if (ghToken) return { token: ghToken, source: "gh-cli" };

  return null;
}

/** Returns the full authentication status (async for username lookup). */
export async function getCopilotAuthStatus(projectDir: string): Promise<CopilotAuthStatus> {
  const resolved = resolveCopilotToken(projectDir);
  if (!resolved) {
    return { authenticated: false, source: null, tokenHint: null, username: null };
  }

  // Token exists — consider authenticated. Username is best-effort for display.
  const username = await getGitHubUsername(resolved.token).catch(() => null);
  return {
    authenticated: true,
    source: resolved.source,
    tokenHint: maskToken(resolved.token),
    username,
  };
}

/**
 * Store a Copilot token in .proto/config.json.
 * Used when the user provides a token manually or after device flow.
 */
export function storeCopilotToken(projectDir: string, token: string): void {
  const config = readProtoConfig(projectDir);
  config["copilotToken"] = token;
  writeProtoConfig(projectDir, config);
}

/**
 * Remove the stored Copilot token from .proto/config.json.
 */
export function clearCopilotToken(projectDir: string): void {
  const config = readProtoConfig(projectDir);
  delete config["copilotToken"];
  writeProtoConfig(projectDir, config);
}

/**
 * Check if the `gh` CLI is available on PATH.
 */
export function isGhCliAvailable(): boolean {
  try {
    execSync("gh --version", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}
