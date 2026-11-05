#!/usr/bin/env node
/**
 * Child-side console guard for stdio (`.mjs`) hooks (owner ticket c478fd86).
 *
 * Preloaded via `node --import <this-guard> <hook-file>`: reroutes
 * `console.log/info/warn/debug` to stderr BEFORE hook code runs, so hook
 * chatter can never pollute stdout — stdout stays reserved for the single
 * JSON document the parent parses. `console.error` already writes stderr
 * and is left untouched; formatting matches console semantics via
 * `node:util` format. The runner prefixes child stderr with
 * `hook <tool>:` and byte-caps it, so these lines keep their diagnostics
 * routing unchanged.
 *
 * Node built-ins only. No runtime import of CLI internals or packages.
 * Resolved like `hook-loader.mjs` (next to the executing bundle — never
 * PATH/cwd) via `resolveGuardEntry` in `runner.ts`; shipped verbatim next
 * to BOTH packaged loaders by `scripts/build-atomic.mjs`.
 */
import { format } from "node:util";

for (const method of ["debug", "info", "log", "warn"]) {
  console[method] = (...args) => {
    process.stderr.write(`${format(...args)}\n`);
  };
}
