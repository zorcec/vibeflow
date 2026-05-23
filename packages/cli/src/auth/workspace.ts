import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VIBEFLOW_DIR = path.join(os.homedir(), ".vibeflow");
const WORKSPACE_PATH = path.join(VIBEFLOW_DIR, "workspace");

export interface WorkspaceInfo {
  id: string;
  name: string;
  icon?: string | null;
  url: string;
  email?: string | null;
}

export async function readWorkspace(): Promise<WorkspaceInfo | null> {
  try {
    const content = await fs.readFile(WORKSPACE_PATH, "utf8");
    return JSON.parse(content) as WorkspaceInfo;
  } catch {
    return null;
  }
}

export async function writeWorkspace(workspace: WorkspaceInfo): Promise<void> {
  await fs.mkdir(VIBEFLOW_DIR, { recursive: true });
  await fs.writeFile(WORKSPACE_PATH, JSON.stringify(workspace, null, 2), { mode: 0o600 });
}

export async function deleteWorkspace(): Promise<void> {
  try {
    await fs.unlink(WORKSPACE_PATH);
  } catch {
    // Already gone
  }
}
