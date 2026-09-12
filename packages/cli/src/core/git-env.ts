/**
 * Environment for running `git` against an explicit working directory.
 *
 * Git exports repo-location variables (notably GIT_DIR and GIT_WORK_TREE) when
 * it invokes hooks such as pre-commit. When such a variable is inherited, every
 * `git` invocation ignores its `cwd` and operates on that other repository —
 * e.g. `git config user.name` reads the wrong identity and `git commit` writes
 * into the wrong repo. Stripping these variables makes `git` resolve the
 * repository from `cwd`, which is what callers targeting a specific project
 * directory expect.
 */
const GIT_LOCATION_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
] as const;

export function gitEnvWithCleanLocation(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of GIT_LOCATION_ENV_VARS) delete env[key];
  return env;
}
