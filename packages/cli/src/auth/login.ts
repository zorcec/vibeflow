import chalk from "chalk";
import open from "open";
import readline from "node:readline";
import select from "@inquirer/select";
import { writeToken, readToken } from "./token.js";
import { writeWorkspace, type WorkspaceInfo } from "./workspace.js";
import { writeGlobalSettings, readGlobalSettings, type ProtoSettings } from "../core/settings.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROTO_DIR, TASKS_DIR } from "../core/types.js";

// Stryker disable once StringLiteral: default API URL is a configuration constant
const DEFAULT_API_URL = "https://app.vibeflow.tools";
const SETTINGS_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function getApiUrl(): string {
  return process.env.VIBEFLOW_API_URL ?? DEFAULT_API_URL;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function promptWorkspaceSelection(workspaces: WorkspaceInfo[]): Promise<WorkspaceInfo> {
  if (workspaces.length === 1) {
    // Stryker disable once StringLiteral: display message for workspace selection
    console.log(chalk.dim(`  Using board: ${workspaces[0]!.icon ?? ""} ${workspaces[0]!.name}`));
    return workspaces[0]!;
  }

  const chosen = await select({
    // Stryker disable once StringLiteral: display message for workspace selection
    message: "Select a board to use:",
    choices: workspaces.map((ws) => ({
      // Stryker disable once StringLiteral: display name for workspace selection
      name: `${ws.icon ?? ""} ${ws.name}`,
      value: ws,
    })),
  });
  return chosen;
}

async function fetchAndApplySettings(apiUrl: string, token: string): Promise<void> {
  try {
    const res = await fetch(`${apiUrl}/api/cli/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { settings: ProtoSettings };
    if (data.settings && Object.keys(data.settings).length > 0) {
      writeGlobalSettings({ ...data.settings, _settingsRefreshedAt: Date.now() });
    }
  } catch {
    // Non-critical
  }
}

export async function maybeRefreshSettings(): Promise<void> {
  try {
    const token = await readToken();
    if (!token) return;
    const existing = readGlobalSettings();
    const lastRefresh = existing._settingsRefreshedAt ?? 0;
    if (Date.now() - lastRefresh < SETTINGS_REFRESH_INTERVAL_MS) return;
    const apiUrl = getApiUrl();
    // Fire-and-forget background refresh
    void fetchAndApplySettings(apiUrl, token);
  } catch {
    // Non-critical
  }
}

async function fetchAndSelectWorkspace(apiUrl: string, token: string): Promise<void> {
  try {
    const [wsRes, profileRes] = await Promise.all([
      fetch(`${apiUrl}/api/cli/workspaces`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiUrl}/api/cli/profile`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    if (!wsRes.ok) return;

    const data = (await wsRes.json()) as { workspaces: WorkspaceInfo[] };
    if (!data.workspaces?.length) {
      console.log(chalk.yellow("  No boards found. Create a board in the web app first."));
      return;
    }

    const profile = profileRes.ok ? ((await profileRes.json()) as { email?: string }) : null;
    const selected = await promptWorkspaceSelection(data.workspaces);
    await writeWorkspace({ ...selected, email: profile?.email ?? null });
    console.log(chalk.green(`  Board set: ${selected.icon ?? ""} ${selected.name}`));
    console.log(chalk.dim(`  Open at: ${selected.url}`));
  } catch {
    // Non-critical — user can still use push --workspace
  }
}

async function promptPushLocalTasks(projectDir: string, apiUrl: string, token: string, workspace: WorkspaceInfo): Promise<void> {
  const tasksDir = join(projectDir, PROTO_DIR, TASKS_DIR);
  if (!existsSync(tasksDir)) return;

  const taskFiles: string[] = [];
  try {
    for (const entry of readdirSync(tasksDir)) {
      if (!entry.startsWith(".")) {
        const dayDir = join(tasksDir, entry);
        for (const f of readdirSync(dayDir).filter((f) => f.endsWith(".json"))) {
          taskFiles.push(join(dayDir, f));
        }
      }
    }
  } catch { return; }

  if (taskFiles.length === 0) return;

  const localTasks = taskFiles.flatMap((f) => {
    try { return [JSON.parse(readFileSync(f, "utf-8")) as { id: string; title?: string; status?: string }]; }
    catch { return []; }
  });

  // Fetch online task IDs to find which ones are not yet synced
  let onlineIds = new Set<string>();
  try {
    const res = await fetch(`${apiUrl}/api/cli/tasks?boardId=${workspace.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as { tasks?: Array<{ id: string; cliId?: string | null }> };
      onlineIds = new Set(
        (data.tasks ?? []).flatMap((t) => [
          t.id,
          ...(t.cliId ? [t.cliId] : []),
        ])
      );
    }
  } catch { /* non-critical — treat all as unsynced */ }

  const unsynced = localTasks.filter((t) => !onlineIds.has(t.id));
  if (unsynced.length === 0) return;

  console.log();
  console.log(chalk.bold(`  ${unsynced.length} local task${unsynced.length !== 1 ? "s are" : " is"} not yet synced to the board:`));
  const preview = unsynced.slice(0, 10);
  for (const t of preview) {
    const status = t.status ? chalk.dim(` [${t.status}]`) : "";
    console.log(chalk.dim(`    • ${t.title ?? t.id}${status}`));
  }
  if (unsynced.length > 10) {
    console.log(chalk.dim(`    … and ${unsynced.length - 10} more`));
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question(chalk.cyan("\n  Push them to your board now? [Y/n]: "), async (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() === "n") {
        console.log(chalk.dim("  Skipped. You can push later with: vibeflow push"));
        resolve();
        return;
      }

      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl2.question(chalk.cyan("  Delete local task files after push? [y/N]: "), async (answer2) => {
        rl2.close();
        const keepLocal = answer2.trim().toLowerCase() !== "y";

        try {
          const res = await fetch(`${apiUrl}/api/cli/import`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ boardId: workspace.id, tasks: unsynced, keepLocalFiles: keepLocal }),
          });
          let data: { imported?: number; skipped?: number; error?: string } = {};
          try { data = await res.json() as typeof data; } catch { /* non-JSON response */ }
          if (!res.ok) {
            console.log(chalk.red(`  Push failed: ${data.error ?? `HTTP ${res.status}`}`));
          } else {
            console.log(chalk.green(`  ✓ Pushed ${data.imported ?? 0} task${(data.imported ?? 0) !== 1 ? "s" : ""} to ${workspace.name}`));
            if ((data.skipped ?? 0) > 0) console.log(chalk.dim(`    (${data.skipped} already existed and were skipped)`));
          }
        } catch (err) {
          console.log(chalk.red(`  Push failed: ${err instanceof Error ? err.message : "Network error"}`));
        }
        resolve();
      });
    });
  });
}

export async function login(projectDir: string = resolve(".")): Promise<void> {
  const apiUrl = getApiUrl();
  console.log(chalk.cyan("  Initiating device login flow..."));

  // Step 1: Request device code
  const initRes = await fetch(`${apiUrl}/api/cli/auth/device-init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!initRes.ok) {
    console.error(
      chalk.red(`  Failed to initiate login: ${initRes.status} ${initRes.statusText}`),
    );
    process.exitCode = 1;
    return;
  }

  const { deviceCode, userCode, verificationUrl, expiresIn } =
    (await initRes.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUrl: string;
      expiresIn: number;
    };

  console.log();
  console.log(chalk.bold("  Open this URL in your browser to authorize:"));
  console.log(chalk.underline(`  ${verificationUrl}`));
  console.log();

  // Try to open the browser automatically
  try {
    await open(verificationUrl);
    console.log(chalk.dim("  (Browser opened automatically)"));
  } catch {
    // Not critical
  }

  // Step 2: Poll for verification
  const deadline = Date.now() + expiresIn * 1000;
  const POLL_INTERVAL = 3000;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);

    const pollRes = await fetch(`${apiUrl}/api/cli/auth/device-poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });

    if (!pollRes.ok) {
      console.error(chalk.red("  Poll request failed. Retrying..."));
      continue;
    }

    const data = (await pollRes.json()) as
      | { pending: true }
      | { token: string }
      | { expired: true };

    if ("token" in data) {
      await writeToken(data.token);
      console.log();
      console.log(chalk.green("  Logged in successfully. Now operating in SaaS mode."));
      await Promise.all([
        fetchAndSelectWorkspace(apiUrl, data.token),
        fetchAndApplySettings(apiUrl, data.token),
      ]);
      // After login, ask if user wants to push local tasks
      const { readWorkspace } = await import("./workspace.js");
      const workspace = await readWorkspace();
      if (workspace) {
        await promptPushLocalTasks(projectDir, apiUrl, data.token, workspace);
      }
      return;
    }

    if ("expired" in data) {
      console.error(chalk.red("  Device code expired. Please try again."));
      process.exitCode = 1;
      return;
    }

    // pending — keep polling
    process.stdout.write(chalk.dim("."));
  }

  console.error(chalk.red("\n  Login timed out. Please try again."));
  process.exitCode = 1;
}
