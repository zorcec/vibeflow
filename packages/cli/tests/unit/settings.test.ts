import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let homeDir: string;
let projectDir: string;

// Redirect os.homedir() to a temp dir so global settings don't pollute tests
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, default: { ...original, homedir: () => homeDir } };
});

import { loadSettings, saveSettings, writeGlobalSettings, readGlobalSettings } from "../../src/core/settings.js";

describe("settings", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "proto-settings-"));
    homeDir = join(tempRoot, "home");
    projectDir = join(tempRoot, "project");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("loadSettings", () => {
    it("returns empty object when .vibeflow dir does not exist", () => {
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("returns empty object when settings.json does not exist", () => {
      mkdirSync(join(projectDir, ".vibeflow"));
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("returns empty object when settings.json is invalid JSON", () => {
      mkdirSync(join(projectDir, ".vibeflow"));
      writeFileSync(join(projectDir, ".vibeflow", "settings.json"), "not-json", "utf-8");
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("returns parsed settings from existing file", () => {
      mkdirSync(join(projectDir, ".vibeflow"));
      const settings = { autoCommit: true, autoComment: false, viewMode: "board" as const };
      writeFileSync(join(projectDir, ".vibeflow", "settings.json"), JSON.stringify(settings), "utf-8");
      expect(loadSettings(projectDir)).toEqual(settings);
    });

    it("merges global settings with local project settings", () => {
      // Set global settings
      writeGlobalSettings({ autoCommit: true, panelWidth: 300 });

      // Create local settings with different values
      mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
      writeFileSync(join(projectDir, ".vibeflow", "settings.json"), JSON.stringify({ viewMode: "list" }), "utf-8");

      const result = loadSettings(projectDir);

      // Local settings should be merged with global
      expect(result.autoCommit).toBe(true);
      expect(result.panelWidth).toBe(300);
      expect(result.viewMode).toBe("list");
    });

    it("local settings override global settings for the same key", () => {
      // Set global settings
      writeGlobalSettings({ autoCommit: true, panelWidth: 300 });

      // Create local settings with overriding value
      mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
      writeFileSync(join(projectDir, ".vibeflow", "settings.json"), JSON.stringify({ autoCommit: false }), "utf-8");

      const result = loadSettings(projectDir);

      // Local should override global
      expect(result.autoCommit).toBe(false);
      expect(result.panelWidth).toBe(300);
    });

    it("returns global settings when local file is invalid JSON", () => {
      // Set global settings
      writeGlobalSettings({ autoCommit: true });

      // Create invalid local settings
      mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
      writeFileSync(join(projectDir, ".vibeflow", "settings.json"), "not-json", "utf-8");

      const result = loadSettings(projectDir);

      // Should fall back to global
      expect(result.autoCommit).toBe(true);
    });
  });

  describe("saveSettings", () => {
    it("creates .vibeflow dir and saves settings when dir does not exist", () => {
      const result = saveSettings(projectDir, { autoCommit: true });
      expect(result.autoCommit).toBe(true);
      expect(loadSettings(projectDir)).toEqual({ autoCommit: true });
    });

    it("merges with existing settings rather than overwriting", () => {
      saveSettings(projectDir, { autoCommit: true });
      saveSettings(projectDir, { autoComment: true });
      const loaded = loadSettings(projectDir);
      expect(loaded.autoCommit).toBe(true);
      expect(loaded.autoComment).toBe(true);
    });

    it("new values overwrite existing values for the same key", () => {
      saveSettings(projectDir, { autoCommit: true });
      saveSettings(projectDir, { autoCommit: false });
      expect(loadSettings(projectDir).autoCommit).toBe(false);
    });

    it("returns merged settings", () => {
      saveSettings(projectDir, { viewMode: "board" });
      const result = saveSettings(projectDir, { panelWidth: 400 });
      expect(result.viewMode).toBe("board");
      expect(result.panelWidth).toBe(400);
    });

    it("saves all ProtoSettings fields", () => {
      const settings = {
        visibleCols: ["todo", "in-progress"],
        viewMode: "list" as const,
        panelWidth: 350,
        autoCommit: true,
        autoComment: false,
      };
      const result = saveSettings(projectDir, settings);
      expect(result).toEqual(settings);
      expect(loadSettings(projectDir)).toEqual(settings);
    });

    it("creates .vibeflow directory in home for global settings", () => {
      const globalDir = join(homeDir, ".vibeflow");
      expect(existsSync(globalDir)).toBe(false);

      writeGlobalSettings({ autoCommit: true });

      expect(existsSync(globalDir)).toBe(true);
    });

    it("does not recreate .vibeflow directory if it already exists", () => {
      const globalDir = join(homeDir, ".vibeflow");
      mkdirSync(globalDir, { recursive: true });

      // Should not throw
      writeGlobalSettings({ autoCommit: true });

      expect(existsSync(globalDir)).toBe(true);
    });

    it("readGlobalSettings returns empty object when file does not exist", () => {
      expect(readGlobalSettings()).toEqual({});
    });

    it("readGlobalSettings returns empty object when file is invalid JSON", () => {
      const globalDir = join(homeDir, ".vibeflow");
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, "settings.json"), "not-json", "utf-8");

      expect(readGlobalSettings()).toEqual({});
    });

    it("readGlobalSettings returns parsed settings when file exists", () => {
      writeGlobalSettings({ autoCommit: true, panelWidth: 400 });

      const result = readGlobalSettings();

      expect(result.autoCommit).toBe(true);
      expect(result.panelWidth).toBe(400);
    });
  });
});
