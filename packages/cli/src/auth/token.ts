import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VIBEFLOW_DIR = path.join(os.homedir(), ".vibeflow");
const TOKEN_PATH = path.join(VIBEFLOW_DIR, "token");

export async function readToken(): Promise<string | null> {
  try {
    const content = (await fs.readFile(TOKEN_PATH, "utf8")).trim();
    return content || null;
  } catch {
    return null;
  }
}

export async function writeToken(token: string): Promise<void> {
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, token, { mode: 0o600 });
}

export async function deleteToken(): Promise<void> {
  try {
    await fs.unlink(TOKEN_PATH);
  } catch {
    // already gone — not an error
  }
}

export function getTokenPath(): string {
  return TOKEN_PATH;
}
