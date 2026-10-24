import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Human-readable token title; the hostname is metadata, not authentication. */
export function getDeviceName(): string {
  return `${os.hostname()} (${os.type()})`;
}

async function readMachineSalt(machinePath: string): Promise<string> {
  const salt = (await fs.readFile(machinePath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(salt)) {
    throw new Error("Invalid machine salt file; refusing to change machine identity.");
  }
  await fs.chmod(machinePath, 0o600);
  return salt;
}

async function getMachineSalt(): Promise<string> {
  const directory = path.join(os.homedir(), ".vibeflow");
  const machinePath = path.join(directory, "machine");
  try {
    return await readMachineSalt(machinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = `${machinePath}.${randomBytes(16).toString("hex")}`;
  await fs.writeFile(temporaryPath, randomBytes(32).toString("hex"), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    // Publish a complete salt atomically: concurrent logins must never read an
    // empty file or replace the winner's salt and change the machine identity.
    try {
      await fs.link(temporaryPath, machinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return await readMachineSalt(machinePath);
  } finally {
    await fs.unlink(temporaryPath);
  }
}

/**
 * Owner-approved machine metadata (increment 3): salt stays in the user's home,
 * separate from the token so logout/revocation cannot change the lookup key.
 * A salted hash avoids exposing a hostname as an id; it is never a credential.
 */
export async function getMachineId(): Promise<string> {
  const salt = await getMachineSalt();
  return createHash("sha256")
    .update(JSON.stringify([os.hostname(), os.type(), salt]))
    .digest("hex");
}
