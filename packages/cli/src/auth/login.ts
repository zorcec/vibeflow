import chalk from "chalk";
import open from "open";
import readline from "node:readline";
import select from "@inquirer/select";
import { writeToken, readToken } from "./token.js";
import { writeWorkspace, type WorkspaceInfo } from "./workspace.js";
import {
  writeGlobalSettings,
  readGlobalSettings,
  type ProtoSettings,
} from "../core/settings.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROTO_DIR, TASKS_DIR } from "../core/types.js";
import { ExitCode } from "../core/exit-codes.js";
import { getApiUrl, surfacePath } from "../core/api-url.js";

const SETTINGS_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function promptWorkspaceSelection(
  workspaces: WorkspaceInfo[],
): Promise<WorkspaceInfo> {
  if (workspaces.length === 1) {
    // Stryker disable once StringLiteral: display message for workspace selection
    console.log(
      chalk.dim(
        `  Using board: ${workspaces[0]!.icon ?? ""} ${workspaces[0]!.name}`,
      ),
    );
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

async function fetchAndApplySettings(
  apiUrl: string,
  token: string,
): Promise<void> {
  try {
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
    const res = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/settings")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { settings: ProtoSettings };
    if (data.settings && Object.keys(data.settings).length > 0) {
      writeGlobalSettings({
        ...data.settings,
        _settingsRefreshedAt: Date.now(),
      });
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

async function fetchAndSelectWorkspace(
  apiUrl: string,
  token: string,
): Promise<void> {
  try {
    const [wsRes, profileRes] = await Promise.all([
      // Cloud-only paths: apiUrl is the getApiUrl() SaaS base → always "cloud".
      fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/workspaces")}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/profile")}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    if (!wsRes.ok) return;

    const data = (await wsRes.json()) as { workspaces: WorkspaceInfo[] };
    if (!data.workspaces?.length) {
      console.log(
        chalk.yellow("  No boards found. Create a board in the web app first."),
      );
      return;
    }

    const profile = profileRes.ok
      ? ((await profileRes.json()) as { email?: string })
      : null;
    const selected = await promptWorkspaceSelection(data.workspaces);
    await writeWorkspace({ ...selected, email: profile?.email ?? null });
    console.log(
      chalk.green(`  Board set: ${selected.icon ?? ""} ${selected.name}`),
    );
    console.log(chalk.dim(`  Open at: ${selected.url}`));
  } catch {
    // Non-critical — user can still use push --workspace
  }
}

/**
 * Cloud batch-import replacement: the v0 contract offers no batch import op,
 * so each unsynced local task is created with one `POST /api/v0/tasks` call
 * (`surfacePath("cloud", "/api/cli/tasks")`). A non-ok response counts the
 * task as skipped (same message shape the single-call import produced).
 * Mode is always `"cloud"`: callers address the `getApiUrl()` SaaS base.
 *
 * `boardId` is optional: callers that push without a selected board omit it
 * and the cloud files the task under the default board (the legacy batch
 * import likewise carried no board when none was selected). `idMap` maps
 * each created task's local id to its cloud id (parsed from the bare v0
 * task body) so
 * callers can follow up with per-task file uploads.
 *
 * Push is TWO-PHASE so links survive the local-id → cloud-id namespace
 * hop. Phase 1 (`createTasksOneByOne` below) creates every task WITHOUT
 * `links`: a local parent link names a LOCAL id the cloud has never seen,
 * so v0's parent-target validation answers 400 and the whole task counts
 * as skipped (a fresh 3-task push with one parent/child pair reported
 * `Pushed 2 … Skipped 1`), and create-order cannot fix it in general — a
 * child pushed before its parent has an unknown target id. Phase 2
 * (`applyPushLinks`) then replays each stored link with the target
 * translated from the local id to the created cloud id from `idMap`, via
 * `POST /api/v0/tasks/{id}/links` (`{ taskId, type }` — the contract's
 * `add-link` op; see its doc comment for the shape choice). Links whose
 * target is not in the push set and unknown in-board are skipped and
 * REPORTED, never fatal to the push.
 */
/**
 * Build the `POST /api/v0/tasks` body for one local task record: the
 * record itself minus `links`, plus `boardId` when selected. Phase 1 of
 * the two-phase push (see `createTasksOneByOne`): `links` is the one key
 * v0 validates against server state (parent targets must already exist
 * in-board), so it travels in phase 2 via `applyPushLinks` with resolved
 * cloud ids — never inline. Everything else unknown (`filePath`,
 * timestamps, `files[]` refs, …) the POST ignores, and the `files[]` refs
 * deliberately ride along (system-flag round-trip pin in `push.test.ts`).
 * `undefined` values are omitted so absent stays absent.
 */
export function toV0CreateBody(
  task: Record<string, unknown>,
  boardId: string | undefined,
): Record<string, unknown> {
  const { links: _dropped, ...rest } = task;
  void _dropped;
  const body: Record<string, unknown> = { ...rest };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  if (boardId !== undefined) body.boardId = boardId;
  else delete body.boardId;
  return body;
}

export async function createTasksOneByOne(
  apiUrl: string,
  token: string,
  boardId: string | undefined,
  tasks: Array<Record<string, unknown>>,
): Promise<{
  imported: number;
  skipped: number;
  idMap: Record<string, string>;
}> {
  let imported = 0;
  let skipped = 0;
  const idMap: Record<string, string> = {};
  const createPath = surfacePath("cloud", "/api/cli/tasks");
  for (const task of tasks) {
    const localId = task.id;
    const res = await fetch(`${apiUrl}${createPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(toV0CreateBody(task, boardId)),
    });
    if (!res.ok) {
      skipped++;
      continue;
    }
    imported++;
    if (typeof localId === "string" && localId.length > 0) {
      // v0 answers the bare created task (contract Task).
      const body = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const created = (body ?? {}) as Record<string, unknown>;
      const remoteId =
        typeof created.id === "string" && created.id.length > 0
          ? created.id
          : localId;
      idMap[localId] = remoteId;
    }
  }
  return { imported, skipped, idMap };
}

/** Link types the v0 link surface accepts. */
const PUSH_LINK_TYPES = new Set(["parent", "relates", "blocks"]);

export interface SkippedPushLink {
  /** Local id of the task carrying the link. */
  from: string;
  /** Stored (local) id of the link target. */
  to: string;
  type: string;
  reason: string;
}

export interface ApplyPushLinksResult {
  applied: number;
  skipped: SkippedPushLink[];
}

/**
 * Phase 2 of the two-phase push: replay every stored `links` entry with
 * the target translated from the local id to the created cloud id.
 *
 * Mechanism is `POST /api/v0/tasks/{id}/links` with `{ taskId, type }`
 * — the v0 contract's `add-link` op (`docs/api/v0-contract.json`, new
 * endpoint shape for links which no longer ride on create/update). The
 * `{ taskId, type }` key spelling matches the live cloud parser (the v0
 * tasks route validates `body.links[]` as `{ taskId, type }` and the
 * links route reads `body.taskId`); the public openapi draft spells the
 * target key `target`, but the cloud this path talks to reads `taskId`,
 * so `taskId` is what travels. A follow-up create/PATCH carrying
 * resolved `links` was rejected: PATCH replaces task state wholesale and
 * risks clobbering, while the links endpoint is additive and idempotent
 * (an already-present pair answers 200 `duplicate: true`).
 *
 * Runs strictly AFTER `createTasksOneByOne`, so every pushed target
 * already exists in-board and parent validation passes regardless of
 * create order. A link whose target is NOT in `idMap` (not part of this
 * push — or its create was skipped) is skipped and reported, never
 * fatal: a single unknown target must not fail the whole push. Per-link
 * HTTP/network failures degrade to skipped entries for the same reason.
 * Mode is always `"cloud"`: callers address the `getApiUrl()` SaaS base.
 */
export async function applyPushLinks(
  apiUrl: string,
  token: string,
  tasks: Array<Record<string, unknown>>,
  idMap: Record<string, string>,
): Promise<ApplyPushLinksResult> {
  let applied = 0;
  const skipped: SkippedPushLink[] = [];
  for (const task of tasks) {
    const localId = task.id;
    if (typeof localId !== "string" || localId.length === 0) continue;
    const remoteSource = idMap[localId];
    const links = task.links;
    if (!Array.isArray(links) || links.length === 0) continue;
    for (const link of links) {
      const target =
        typeof link === "object" && link !== null
          ? (link as Record<string, unknown>).taskId
          : undefined;
      const type =
        typeof link === "object" && link !== null
          ? (link as Record<string, unknown>).type
          : undefined;
      if (
        typeof target !== "string" ||
        target.length === 0 ||
        typeof type !== "string" ||
        !PUSH_LINK_TYPES.has(type)
      ) {
        skipped.push({
          from: localId,
          to: typeof target === "string" ? target : "",
          type: typeof type === "string" ? type : "",
          reason: "malformed link entry",
        });
        continue;
      }
      if (remoteSource === undefined) {
        skipped.push({
          from: localId,
          to: target,
          type,
          reason: "source task was not created",
        });
        continue;
      }
      const remoteTarget = idMap[target];
      if (remoteTarget === undefined) {
        skipped.push({
          from: localId,
          to: target,
          type,
          reason: "link target is not part of this push",
        });
        continue;
      }
      try {
        // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always
        // "cloud", so the legacy `/api/cli/tasks/:id/links` form maps to
        // the v0 `add-link` op (`/api/v0/tasks/:id/links`).
        const res = await fetch(
          `${apiUrl}${surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(remoteSource)}/links`)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ taskId: remoteTarget, type }),
          },
        );
        if (res.ok) {
          applied++;
        } else {
          skipped.push({
            from: localId,
            to: target,
            type,
            reason: `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        skipped.push({
          from: localId,
          to: target,
          type,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { applied, skipped };
}

async function promptPushLocalTasks(
  projectDir: string,
  apiUrl: string,
  token: string,
  workspace: WorkspaceInfo,
): Promise<void> {
  const tasksDir = join(projectDir, PROTO_DIR, TASKS_DIR);
  if (!existsSync(tasksDir)) return;

  const taskFiles: string[] = [];
  try {
    for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const dayDir = join(tasksDir, entry.name);
        for (const f of readdirSync(dayDir).filter((f) =>
          f.endsWith(".json"),
        )) {
          taskFiles.push(join(dayDir, f));
        }
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        // Legacy flat layout — task JSON files directly under tasks/.
        taskFiles.push(join(tasksDir, entry.name));
      }
    }
  } catch {
    return;
  }

  if (taskFiles.length === 0) return;

  const localTasks = taskFiles.flatMap((f) => {
    try {
      return [
        JSON.parse(readFileSync(f, "utf-8")) as {
          id: string;
          title?: string;
          status?: string;
        },
      ];
    } catch {
      return [];
    }
  });

  // Fetch online task IDs to find which ones are not yet synced
  let onlineIds = new Set<string>();
  try {
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
    const res = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/tasks")}?boardId=${workspace.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (res?.ok) {
      const data = (await res.json()) as {
        items?: Array<Record<string, unknown>>;
        // Legacy fallback: the deleted `/api/cli/tasks` surface answered
        // `{ tasks }`; its rows carried `id` + `cliId`.
        tasks?: Array<{ id: string; cliId?: string | null }>;
      };
      // v0 canonical shape carries BOTH `id` (external) and `externalId`
      // (§3.1: `cliId ?? cloudId`); collect every id-like key so a local
      // task matching ANY of them counts as already synced.
      const rows = Array.isArray(data.items)
        ? data.items
        : (Array.isArray(data.tasks) ? data.tasks : []);
      const ids: string[] = [];
      for (const t of rows) {
        for (const key of ["id", "externalId", "cloudId", "cliId"]) {
          const v = (t as Record<string, unknown>)[key];
          if (typeof v === "string" && v.length > 0) ids.push(v);
        }
      }
      onlineIds = new Set(ids);
    }
  } catch {
    /* non-critical — treat all as unsynced */
  }

  const unsynced = localTasks.filter((t) => !onlineIds.has(t.id));
  if (unsynced.length === 0) return;

  console.log();
  console.log(
    chalk.bold(
      `  ${unsynced.length} local task${unsynced.length !== 1 ? "s are" : " is"} not yet synced to the board:`,
    ),
  );
  const preview = unsynced.slice(0, 10);
  for (const t of preview) {
    const status = t.status ? chalk.dim(` [${t.status}]`) : "";
    console.log(chalk.dim(`    • ${t.title ?? t.id}${status}`));
  }
  if (unsynced.length > 10) {
    console.log(chalk.dim(`    … and ${unsynced.length - 10} more`));
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      chalk.cyan("\n  Push them to your board now? [Y/n]: "),
      async (answer) => {
        rl.close();
        if (answer.trim().toLowerCase() === "n") {
          console.log(
            chalk.dim("  Skipped. You can push later with: vibeflow push"),
          );
          resolve();
          return;
        }

        const rl2 = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl2.question(
          chalk.cyan("  Delete local task files after push? [y/N]: "),
          async (answer2) => {
            rl2.close();
            const keepLocal = answer2.trim().toLowerCase() !== "y";
            void keepLocal;

            // No batch import exists in the v0 contract: one POST per task
            // (phase 1), then links replayed with resolved cloud ids
            // (phase 2). (keepLocalFiles previously rode along to
            // /api/cli/import; the v0 create op has no such field and this
            // flow never deleted client-side, so the answer is kept for
            // prompt parity only.)
            try {
              const records = unsynced as Array<Record<string, unknown>>;
              const data = await createTasksOneByOne(
                apiUrl,
                token,
                workspace.id,
                records,
              );
              console.log(
                chalk.green(
                  `  ✓ Pushed ${data.imported} task${data.imported !== 1 ? "s" : ""} to ${workspace.name}`,
                ),
              );
              if (data.skipped > 0)
                console.log(
                  chalk.dim(
                    `    (${data.skipped} already existed and were skipped)`,
                  ),
                );
              const links = await applyPushLinks(apiUrl, token, records, data.idMap);
              if (links.applied > 0)
                console.log(
                  chalk.green(
                    `  ✓ Applied ${links.applied} link${links.applied !== 1 ? "s" : ""}`,
                  ),
                );
              if (links.skipped.length > 0)
                console.log(
                  chalk.dim(
                    `    (Skipped ${links.skipped.length} link${links.skipped.length !== 1 ? "s" : ""} with unknown targets: ${links.skipped.map((l) => `${l.from}→${l.to} (${l.type})`).join(", ")})`,
                  ),
                );
            } catch (err) {
              console.log(
                chalk.red(
                  `  Push failed: ${err instanceof Error ? err.message : "Network error"}`,
                ),
              );
            }
            resolve();
          },
        );
      },
    );
  });
}

export async function login(projectDir: string = resolve(".")): Promise<void> {
  const apiUrl = getApiUrl();
  console.log(chalk.cyan("  Initiating device login flow..."));

  let initRes: Response;
  try {
    // Step 1: Request device code
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
    initRes = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/auth/device-init")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(
      chalk.red(
        `  Failed to connect to login server: ${err instanceof Error ? err.message : "Network error"}`,
      ),
    );
    process.exitCode = ExitCode.AUTH;
    return;
  }

  if (!initRes.ok) {
    console.error(
      chalk.red(
        `  Failed to initiate login: ${initRes.status} ${initRes.statusText}`,
      ),
    );
    process.exitCode = ExitCode.AUTH;
    return;
  }

  const { deviceCode, verificationUrl, expiresIn } = (await initRes.json()) as {
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
  };

  console.log();
  console.log(chalk.bold("  Open this URL in your browser to authorize:"));
  console.log(chalk.underline(`  ${verificationUrl}`));
  console.log();

  // Try to open the browser automatically.
  //
  // Skipped when `VIBEFLOW_NO_BROWSER=1`, or when the process has no TTY — an
  // unattended process (CI, a script, a test harness) has no business spawning
  // a browser. Without this, every `vibeflow login` in an automated run opened a
  // real tab on the developer's desktop, which is both disruptive and a way for
  // a test suite to leak into the user's session. The URL is printed either way,
  // so nothing is lost.
  const canOpenBrowser =
    process.env.VIBEFLOW_NO_BROWSER !== "1" && process.stdout.isTTY === true;
  if (canOpenBrowser) {
    try {
      await open(verificationUrl);
      console.log(chalk.dim("  (Browser opened automatically)"));
    } catch {
      // Not critical
    }
  }

  // Step 2: Poll for verification
  const deadline = Date.now() + expiresIn * 1000;
  const POLL_INTERVAL = 3000;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);

    let pollRes: Response | null = null;
    try {
      // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
      pollRes = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/auth/device-poll")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
    } catch {
      console.error(
        chalk.red("  Poll request failed (network error). Retrying..."),
      );
      continue;
    }

    if (!pollRes.ok) {
      console.error(chalk.red("  Poll request failed. Retrying..."));
      continue;
    }

    // The device flow issues an `api_tokens` PAT directly: the server
    // mints it on authorization and returns the plaintext exactly once in
    // `{ token }`. There is no other token shape — the PAT is stored
    // verbatim and is the Bearer credential for every cloud call below
    // (`/api/v0` via `surfacePath("cloud", …)`).
    const data = (await pollRes.json()) as
      | { pending: true }
      | { token: string }
      | { expired: true };

    if ("token" in data) {
      const pat = data.token;
      await writeToken(pat);
      console.log();
      console.log(
        chalk.green("  Logged in successfully. Now operating in SaaS mode."),
      );
      await Promise.all([
        fetchAndSelectWorkspace(apiUrl, pat),
        fetchAndApplySettings(apiUrl, pat),
      ]);
      // After login, ask if user wants to push local tasks
      const { readWorkspace } = await import("./workspace.js");
      const workspace = await readWorkspace();
      if (workspace) {
        await promptPushLocalTasks(projectDir, apiUrl, pat, workspace);
      }
      return;
    }

    if ("expired" in data) {
      console.error(chalk.red("  Device code expired. Please try again."));
      process.exitCode = ExitCode.AUTH;
      return;
    }

    // pending — keep polling
    process.stdout.write(chalk.dim("."));
  }

  console.error(chalk.red("\n  Login timed out. Please try again."));
  process.exitCode = ExitCode.AUTH;
}
