import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getConfigPath,
  hasProtoDir,
  ensureProtoDir,
  readConfig,
  writeConfig,
  getProjectName,
} from "../../src/core/config.js";
import type { ProtoConfig } from "../../src/core/types.js";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-config-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getConfigPath returns .vibeflow/config.json path", () => {
    expect(getConfigPath(tempDir)).toBe(join(tempDir, ".vibeflow", "config.json"));
  });

  it("hasProtoDir returns false when .proto does not exist", () => {
    expect(hasProtoDir(tempDir)).toBe(false);
  });

  it("hasProtoDir returns true after ensureProtoDir", () => {
    ensureProtoDir(tempDir);
    expect(hasProtoDir(tempDir)).toBe(true);
  });

  it("readConfig returns defaults when no config file", () => {
    const config = readConfig(tempDir);
    expect(config.port).toBe(3700);
  });

  it("writeConfig creates config file and readConfig reads it", () => {
    const config: ProtoConfig = { port: 4000 };
    writeConfig(tempDir, config);

    expect(existsSync(getConfigPath(tempDir))).toBe(true);

    const read = readConfig(tempDir);
    expect(read.port).toBe(4000);
  });

  it("writeConfig creates .proto directory if missing", () => {
    expect(hasProtoDir(tempDir)).toBe(false);
    writeConfig(tempDir, { port: 3700 });
    expect(hasProtoDir(tempDir)).toBe(true);
  });

  it("readConfig merges with defaults for partial config", () => {
    ensureProtoDir(tempDir);
    const configPath = getConfigPath(tempDir);
    const partial = JSON.stringify({ port: 4000 });
    const { writeFileSync } = require("node:fs");
    writeFileSync(configPath, partial, "utf-8");

    const config = readConfig(tempDir);
    expect(config.port).toBe(4000); // from file
  });
});

describe("getProjectName", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-project-name-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns directory basename when no package.json exists", () => {
    const name = getProjectName(tempDir);
    expect(name).toBe(tempDir.split("/").pop());
  });

  it("returns package name when package.json has a name field", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "my-project" }), "utf-8");
    expect(getProjectName(tempDir)).toBe("my-project");
  });

  it("returns directory basename when package.json has no name field", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ version: "1.0.0" }), "utf-8");
    const name = getProjectName(tempDir);
    expect(name).toBe(tempDir.split("/").pop());
  });

  it("returns directory basename when package.json has invalid JSON", () => {
    writeFileSync(join(tempDir, "package.json"), "{ invalid json }", "utf-8");
    const name = getProjectName(tempDir);
    expect(name).toBe(tempDir.split("/").pop());
  });
});
