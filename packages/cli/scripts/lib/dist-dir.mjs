import { isAbsolute, resolve } from "node:path";

/**
 * Build-output directory for the CLI package, honouring the
 * `VIBEFLOW_DIST_DIR` override used by scripts/build-atomic.mjs to stage a
 * build outside the live `dist/` (ticket 328b5420). Unset (plain `tsup`,
 * `dev`, direct generator runs) means the live `dist/` as before.
 */
export function resolveDistDir(packageRoot) {
  const override = process.env.VIBEFLOW_DIST_DIR;
  if (!override) return resolve(packageRoot, "dist");
  return isAbsolute(override)
    ? override
    : resolve(packageRoot, override);
}
