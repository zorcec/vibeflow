/**
 * CLI telemetry — tracks command usage via PostHog.
 *
 * Opt-out (default: enabled):
 *   - Set env var:  VIBEFLOW_TELEMETRY=0
 *   - Run command:  vibeflow telemetry --disable
 *
 * Privacy guarantees:
 *   - No PII: username is hashed (SHA-256, first 16 hex chars).
 *   - No file paths, task IDs, or content.
 *   - Anonymous UUID stored in ~/.vibeflow/config.json.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { PostHog } from "posthog-node";

// PostHog capture key for the CLI project (public, safe to embed in client code)
const POSTHOG_API_KEY = "phc_C9AUV3rnayLfVvxgHtvj6AXcwsd8FKWUfJ9262zWsCvM";
const POSTHOG_HOST = "https://eu.i.posthog.com";

// Lazy helpers so tests can override HOME via process.env before importing this module
function getConfigDir(): string {
  return join(process.env.HOME ?? os.homedir(), ".vibeflow");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

interface TelemetryConfig {
  anonymousId?: string;
  disabled?: boolean;
}

function readConfig(): TelemetryConfig {
  try {
    return JSON.parse(readFileSync(getConfigPath(), "utf-8")) as TelemetryConfig;
  } catch {
    return {};
  }
}

function writeConfig(updates: Partial<TelemetryConfig>): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = readConfig();
  writeFileSync(getConfigPath(), JSON.stringify({ ...current, ...updates }, null, 2), "utf-8");
}

export function isTelemetryEnabled(): boolean {
  if (process.env.VIBEFLOW_TELEMETRY === "0") return false;
  return readConfig().disabled !== true;
}

export function setTelemetryEnabled(enabled: boolean): void {
  writeConfig({ disabled: !enabled });
}

export function getTelemetryStatus(): { enabled: boolean; anonymousId: string | null } {
  const enabled = isTelemetryEnabled();
  const config = readConfig();
  return { enabled, anonymousId: config.anonymousId ?? null };
}

function getAnonymousId(): string {
  const config = readConfig();
  if (config.anonymousId) return config.anonymousId;
  const id = randomUUID();
  writeConfig({ anonymousId: id });
  return id;
}

function getUserHash(): string {
  const username = os.userInfo().username;
  return createHash("sha256").update(username).digest("hex").slice(0, 16);
}

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!isTelemetryEnabled()) return null;
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return client;
}

export function capture(event: string, properties?: Record<string, unknown>): void {
  const ph = getClient();
  if (!ph) return;
  const distinctId = getAnonymousId();
  ph.capture({
    distinctId,
    event,
    properties: {
      ...properties,
      $user_id: getUserHash(),
    },
  });
}

export async function flushTelemetry(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch {
    // Silently ignore telemetry flush errors — never block the CLI
  }
}
