/**
 * Shared git commit helper.
 *
 * Used by CLI commit mode, CLI edit-mode auto-commit, and MCP update_task
 * to ensure identical commit logic across all three surfaces.
 *
 * Convention: commit message is tagged with [vibeflow:<taskId>] (legacy
 * [proto:<taskId>] still parses) and the commit
 * record (sha + message + timestamp) is appended to the task's `commits` array.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { formatCommitTag } from "./commit-tag.js";
import { gitEnvWithCleanLocation } from "./git-env.js";
import * as tasksModule from "./tasks.js";
import { getFilesDir } from "./files.js";

/**
 * Resolution for the commit link (ticket 3d9a2b97): the ONE shared lookup
 * (`resolveLocalTask` — the same implementation `--get` resolves through
 * via the store port), not a second file-path scan. ADR-0003.
 *
 * The store rewrites task files on every operation (tmp-file + atomic
 * rename), so a scan that runs AFTER the resolve can land mid-rewrite and
 * miss a record that is present a moment later. A transient `missing` is
 * therefore retried ONCE; only a persistent miss fails — loudly, naming
 * the id it resolved and the directory it looked in.
 *
 * Callers operate on the returned snapshot (resolved full id + file path)
 * rather than re-deriving a path later, so the resolve and the write agree
 * on which record they mean.
 */
function resolveCommitTarget(
  projectDir: string,
  taskId: string,
):
  | { ok: true; fullId: string; filePath: string }
  | { ok: false; error: string } {
  let resolution = tasksModule.resolveLocalTask(projectDir, taskId);
  if (resolution.status === "missing") {
    resolution = tasksModule.resolveLocalTask(projectDir, taskId);
  }
  if (resolution.status === "found") {
    return {
      ok: true,
      fullId: resolution.id,
      filePath: resolution.filePath,
    };
  }
  if (resolution.status === "unreadable") {
    return {
      ok: false,
      error: `Task file for ${taskId} exists but did not parse: ${resolution.filePath}`,
    };
  }
  if (resolution.status === "ambiguous") {
    return {
      ok: false,
      error: `Ambiguous task id prefix "${resolution.id}" matches ${resolution.candidates.length} tasks: ${resolution.candidates.join(", ")}`,
    };
  }
  return {
    ok: false,
    error: `Task file not found: ${resolution.id} (looked in ${tasksModule.getTasksDir(projectDir)})`,
  };
}

/**
 * Appends a commit record (sha + message + timestamp) to the task's
 * `commits` array. Snapshot-consistent: the existing records are read from
 * the ALREADY-RESOLVED file path and the write goes through `updateTask`
 * keyed on the resolved full id — never a re-derived path. A concurrent
 * rewrite that slips between the read and the write makes `updateTask`
 * miss, so that miss is retried once against a fresh resolution; a
 * persistent miss returns an error (never a silent drop — the old code
 * ignored the `updateTask` null and lost the ticket↔commit link quietly).
 *
 * Returns an error string when the link could not be recorded, else null.
 */
function appendCommitRecord(
  projectDir: string,
  filePath: string,
  fullId: string,
  message: string,
  sha: string,
): string | null {
  const record = {
    sha,
    message,
    timestamp: new Date().toISOString(),
  };
  const appendTo: (
    commits: Array<{ sha: string; message: string; timestamp: string }>,
  ) => ReturnType<typeof tasksModule.updateTask> = (commits) =>
    tasksModule.updateTask(projectDir, fullId, {
      commits: [...commits, record],
    });
  const existingCommits =
    tasksModule.readTaskFile(filePath)?.commits ?? [];
  if (appendTo(existingCommits)) return null;
  // Lost a concurrent rewrite between resolve and write: re-resolve once
  // and retry against the fresh snapshot instead of failing the link.
  const retry = tasksModule.resolveLocalTask(projectDir, fullId);
  if (retry.status === "found") {
    if (appendTo(retry.task.commits ?? [])) return null;
  }
  return (
    `Failed to record commit ${sha} on task ${fullId}: ` +
    `task file not found (looked in ${tasksModule.getTasksDir(projectDir)})`
  );
}

/**
 * Commits the task's own file and its attachment directory, and nothing else.
 *
 * Every lane shares one git index in one working tree, so a plain `git commit`
 * commits whatever ANY lane has staged — sweeping another lane's files into this
 * task's commit and misattributing them (this is how a foreign deletion once got
 * swept into an unrelated commit). A pathspec-limited commit can only ever
 * include this task's file plus files under its own attachments directory.
 */
export function commitTaskChanges(
  projectDir: string,
  taskId: string,
  message: string,
):
  | { ok: true; sha: string; linkedExisting?: boolean }
  | { ok: false; error: string } {
  try {
    // One shared lookup (ticket 3d9a2b97) — never a second scan that can
    // lose a rewrite-window race the read path never runs.
    const target = resolveCommitTarget(projectDir, taskId);
    if (!target.ok) return target;
    const { fullId, filePath } = target;
    const commitMsg = `${message} ${formatCommitTag(fullId)}`;

    const relTaskPath = relative(projectDir, filePath);
    const relFilesDir = relative(projectDir, getFilesDir(projectDir, fullId));
    // Existing paths owned by this task. The attachments directory may not
    // exist (no files attached yet) — git rejects a pathspec that matches
    // nothing, so only existing paths are ever passed to it.
    const ownedExisting = [relTaskPath];
    if (existsSync(join(projectDir, relFilesDir)))
      ownedExisting.push(relFilesDir);

    // Commit into `projectDir`'s repo even when a GIT_DIR/GIT_WORK_TREE leaked
    // from an enclosing hook (e.g. the pre-commit hook running the test suite).
    const env = gitEnvWithCleanLocation();
    // Capture git's own stderr instead of letting it reach the CLI's: under
    // `--json` a consumer parses stderr as one envelope, and a raw git
    // usage dump in front of it breaks the parse. Node folds the captured
    // stderr into the thrown error's message, so nothing is lost.
    const gitOpts: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: ["ignore", "pipe", "pipe"];
    } = {
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    };

    // The review-transition auto-commit saves status+comment to the task file
    // and THEN commits — the save leaves unstaged modifications (or a wholly
    // untracked file) that a staged-only check reports as "No staged
    // changes" while committing nothing. Stage the task's OWN record first:
    // an exact-path `git add` also stages an untracked new file, and it
    // cannot sweep another lane's staged work into this commit — the
    // pathspec-limited commit below still only ever includes this task's
    // file plus its own attachments directory.
    try {
      execFileSync("git", ["add", "--", ...ownedExisting], gitOpts);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Only staged paths that belong to THIS task are eligible. `git diff
    // --cached --name-only` lists staged paths relative to the repo root, which
    // is `projectDir`; paths that another lane staged are left untouched in the
    // index and stay staged for their own owner to commit.
    const staged = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      gitOpts,
    )
      .toString()
      .split("\0")
      .filter(Boolean);
    const scoped = staged.filter(
      (p) =>
        p === relTaskPath ||
        p === relFilesDir ||
        p.startsWith(`${relFilesDir}/`),
    );
    if (scoped.length === 0) {
      // Fully clean after staging: the record is tracked and matches HEAD,
      // so the work IS committed — link HEAD instead of reporting a miss,
      // mirroring commitTaskPaths' never-dead-end contract. (Reached e.g.
      // by a re-save that changed no bytes.)
      try {
        const dirty = execFileSync(
          "git",
          ["status", "--porcelain", "-z", "--", ...ownedExisting],
          gitOpts,
        )
          .toString()
          .split("\0")
          .filter(Boolean);
        if (dirty.length === 0) {
          const sha = execSync("git rev-parse HEAD", gitOpts)
            .toString()
            .trim();
          const linkError = appendCommitRecord(
            projectDir,
            filePath,
            fullId,
            message,
            sha,
          );
          if (linkError) return { ok: false, error: linkError };
          return { ok: true, sha, linkedExisting: true };
        }
      } catch {
        // Not a clean tree (or no HEAD) — fall through to the error below.
      }
      return {
        ok: false,
        error: `No staged changes for task ${fullId}. Stage the task file first: git add ${relTaskPath}`,
      };
    }

    execFileSync("git", ["commit", "-m", commitMsg, "--", ...scoped], gitOpts);
    const sha = execSync("git rev-parse HEAD", gitOpts).toString().trim();

    // Append commit record — updateTask handles its own locking. A lost
    // record link is a loud failure, never a silent drop.
    const linkError = appendCommitRecord(
      projectDir,
      filePath,
      fullId,
      message,
      sha,
    );
    if (linkError) return { ok: false, error: linkError };

    return { ok: true, sha };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Result of a path-scoped task commit (see {@link commitTaskPaths}). */
export type TaskCommitResult =
  | {
      ok: true;
      sha: string;
      /**
       * True when there was nothing to commit, so the current HEAD was linked to
       * the task instead of creating a commit. `sha` is that existing HEAD.
       */
      linkedExisting: boolean;
      /** Repo-relative paths included in the commit (empty when linking HEAD). */
      committed: string[];
      /**
       * Staged paths outside this task's scope that were left in the index for
       * their own owner. Only populated when no explicit pathspec was given.
       */
      foreign: string[];
    }
  | { ok: false; error: string };

/**
 * Commits for a task, limited to an optional pathspec, and never dead-ends.
 *
 * - With explicit `paths`, exactly those paths are committed (git's own pathspec
 *   form); every other staged path is left in the index for its owner.
 * - With no paths, the scope is the task's own record — its JSON file and
 *   attachment directory — the same scoping as {@link commitTaskChanges}.
 * - When there is nothing to commit the current HEAD is linked to the task
 *   instead of failing: the caller's intent is "record that this task's work is
 *   in commit X", and when the work is already committed, X is HEAD. This is
 *   the case that used to leave a task with no commit link after a clean tree.
 *
 * Unlike {@link commitTaskChanges}, this helper never requires the caller to
 * stage anything, so a bare `git commit` is never needed and the shared index is
 * never swept.
 */
export function commitTaskPaths(
  projectDir: string,
  taskId: string,
  message: string,
  paths: string[] = [],
): TaskCommitResult {
  try {
    const env = gitEnvWithCleanLocation();
    // One shared lookup (ticket 3d9a2b97) — never a second scan that can
    // lose a rewrite-window race the read path never runs.
    const target = resolveCommitTarget(projectDir, taskId);
    if (!target.ok) return target;
    const { fullId, filePath } = target;
    const commitMsg = `${message} ${formatCommitTag(fullId)}`;

    const relTaskPath = relative(projectDir, filePath);
    const relFilesDir = relative(projectDir, getFilesDir(projectDir, fullId));
    const belongsToTask = (p: string): boolean =>
      p === relTaskPath ||
      p === relFilesDir ||
      p.startsWith(`${relFilesDir}/`);

    const staged = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      // See commitTaskChanges: git's stderr is captured, never inherited, so a
      // `--json` refusal leaves stderr as one parseable envelope.
      { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] },
    )
      .toString()
      .split("\0")
      .filter(Boolean);

    // Explicit paths win: they are exactly what the caller asked to commit. With
    // no pathspec, scope to this task's own record and keep the rest of the
    // index intact for whichever lane staged it.
    const explicit = paths.length > 0;
    const scoped = explicit ? paths : staged.filter(belongsToTask);
    const foreign = explicit ? [] : staged.filter((p) => !belongsToTask(p));

    // `git commit -- <paths>` records the working-tree content of those paths, so
    // any change (staged, unstaged, or untracked) counts. Without a pathspec the
    // task's own record must be staged, matching commitTaskChanges.
    const hasChanges = explicit
      ? execFileSync(
          "git",
          ["status", "--porcelain", "-z", "--", ...scoped],
          { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] },
        )
          .toString()
          .split("\0")
          .filter(Boolean).length > 0
      : scoped.length > 0;

    if (!hasChanges) {
      const sha = execSync("git rev-parse HEAD", {
        cwd: projectDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })
        .toString()
        .trim();
      const linkError = appendCommitRecord(
        projectDir,
        filePath,
        fullId,
        message,
        sha,
      );
      if (linkError) return { ok: false, error: linkError };
      return { ok: true, sha, linkedExisting: true, committed: [], foreign };
    }

    // Never a bare `git commit`: the pathspec keeps another lane's staged work
    // in the index.
    execFileSync("git", ["commit", "-m", commitMsg, "--", ...scoped], {
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sha = execSync("git rev-parse HEAD", {
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    const linkError = appendCommitRecord(
      projectDir,
      filePath,
      fullId,
      message,
      sha,
    );
    if (linkError) return { ok: false, error: linkError };
    return { ok: true, sha, linkedExisting: false, committed: scoped, foreign };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
