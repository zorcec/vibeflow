import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { PROTO_DIR } from "./types.js";

const SETTINGS_FILE = "settings.json";

function getGlobalSettingsPath(): string {
  return join(os.homedir(), ".vibeflow", "settings.json");
}

export interface ProtoSettings {
  visibleCols?: string[];
  viewMode?: "board" | "list";
  panelWidth?: number;
  autoCommit?: boolean;
  autoComment?: boolean;
  autoPush?: boolean;
  createBranch?: boolean;
  requireVerifyBeforeReview?: boolean;
}

function getSettingsPath(projectDir: string): string {
  return join(projectDir, PROTO_DIR, SETTINGS_FILE);
}

function readGlobalSettings(): ProtoSettings {
  try {
    return JSON.parse(
      readFileSync(getGlobalSettingsPath(), "utf-8"),
    ) as ProtoSettings;
  } catch {
    return {};
  }
}

export { readGlobalSettings };

let settingsTmpCounter = 0;

/**
 * Ticket d5178789: unique temp names for concurrent CLI invocations.
 * Two projects sharing the global settings target used to race on one
 * fixed `.tmp` name; pid+counter makes each writer's temp file its own.
 */
function uniqueSettingsTmp(target: string): string {
  settingsTmpCounter += 1;
  return `${target}.tmp.${process.pid}.${settingsTmpCounter}`;
}

export function writeGlobalSettings(settings: ProtoSettings): void {
  const dir = join(os.homedir(), ".vibeflow");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = getGlobalSettingsPath();
  const tmp = uniqueSettingsTmp(target);
  writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf-8");
  renameSync(tmp, target);
}

export function loadSettings(projectDir: string): ProtoSettings {
  const global = readGlobalSettings();
  const settingsPath = getSettingsPath(projectDir);
  if (!existsSync(settingsPath)) return global;
  try {
    const local = JSON.parse(
      readFileSync(settingsPath, "utf-8"),
    ) as ProtoSettings;
    // Local project settings override global/SaaS settings
    return { ...global, ...local };
  } catch {
    return global;
  }
}

export function saveSettings(
  projectDir: string,
  settings: ProtoSettings,
): ProtoSettings {
  const protoDir = join(projectDir, PROTO_DIR);
  if (!existsSync(protoDir)) mkdirSync(protoDir, { recursive: true });
  const settingsPath = getSettingsPath(projectDir);
  const existing = loadSettings(projectDir);
  const merged = { ...existing, ...settings };
  const tmp = uniqueSettingsTmp(settingsPath);
  writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf-8");
  renameSync(tmp, settingsPath);
  return merged;
}
