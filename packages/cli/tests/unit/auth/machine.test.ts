import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDeviceName, getMachineId } from "../../../src/auth/machine.js";

afterEach(() => vi.restoreAllMocks());

describe("getDeviceName", () => {
  it.each(["Linux", "Darwin", "Windows_NT"])("includes hostname and %s", (system) => {
    vi.spyOn(os, "hostname").mockReturnValue("test-laptop");
    vi.spyOn(os, "type").mockReturnValue(system);
    expect(getDeviceName()).toBe(`test-laptop (${system})`);
  });
});

describe("getMachineId", () => {
  let home: string;
  let machinePath: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "vibeflow-machine-"));
    machinePath = path.join(home, ".vibeflow", "machine");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(os, "hostname").mockReturnValue("test-laptop");
    vi.spyOn(os, "type").mockReturnValue("Linux");
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("creates a random salt once with 0600 permissions and hashes hostname + OS + salt", async () => {
    const id = await getMachineId();
    const salt = await fs.readFile(machinePath, "utf8");
    const before = await fs.stat(machinePath);
    expect(salt).toMatch(/^[a-f0-9]{64}$/);
    expect(before.mode & 0o777).toBe(0o600);
    expect(id).toBe(createHash("sha256").update(JSON.stringify(["test-laptop", "Linux", salt])).digest("hex"));
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(id).not.toContain("test-laptop");

    expect(await getMachineId()).toBe(id);
    expect(await fs.readFile(machinePath, "utf8")).toBe(salt);
    expect((await fs.stat(machinePath)).mtimeMs).toBe(before.mtimeMs);
  });

  it("survives module reload and token deletion without rotating the salt", async () => {
    const id = await getMachineId();
    const tokenPath = path.join(home, ".vibeflow", "token");
    await fs.writeFile(tokenPath, "test-only-local-credential", { mode: 0o600 });
    await fs.unlink(tokenPath);
    vi.resetModules();
    const reloaded = await import("../../../src/auth/machine.js");
    expect(await reloaded.getMachineId()).toBe(id);
  });

  it("isolates separate home directories even with the same hostname and OS", async () => {
    const id = await getMachineId();
    const otherHome = path.join(home, "other-user");
    vi.mocked(os.homedir).mockReturnValue(otherHome);
    expect(await getMachineId()).not.toBe(id);
  });

  it("changes the hash when the hostname or OS changes", async () => {
    const id = await getMachineId();
    vi.mocked(os.hostname).mockReturnValue("other-laptop");
    expect(await getMachineId()).not.toBe(id);
    vi.mocked(os.hostname).mockReturnValue("test-laptop");
    vi.mocked(os.type).mockReturnValue("Darwin");
    expect(await getMachineId()).not.toBe(id);
  });

  it("concurrent first logins reuse one complete salt without leaving temporary files", async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => getMachineId()));
    expect(new Set(ids).size).toBe(1);
    expect(await fs.readdir(path.dirname(machinePath))).toEqual(["machine"]);
    expect((await fs.stat(machinePath)).mode & 0o777).toBe(0o600);
  });

  it("repairs overly broad permissions without replacing the salt", async () => {
    const id = await getMachineId();
    await fs.chmod(machinePath, 0o644);
    expect(await getMachineId()).toBe(id);
    expect((await fs.stat(machinePath)).mode & 0o777).toBe(0o600);
  });

  it("does not replace a corrupt salt or expose its contents in an error", async () => {
    await fs.mkdir(path.dirname(machinePath), { recursive: true });
    await fs.writeFile(machinePath, "invalid-test-salt", { mode: 0o600 });
    await expect(getMachineId()).rejects.toThrow("Invalid machine salt file; refusing to change machine identity.");
    expect(await fs.readFile(machinePath, "utf8")).toBe("invalid-test-salt");
  });

  it("does not swallow filesystem errors or rotate identity", async () => {
    await fs.mkdir(machinePath, { recursive: true });
    await expect(getMachineId()).rejects.toMatchObject({ code: "EISDIR" });
  });
});
