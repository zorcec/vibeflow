#!/usr/bin/env node
/**
 * Isolated module-hook loader (ADR-0006 Stage 1.5).
 *
 * A SEPARATE executable child entry — never preloaded into the CLI, never
 * imported in-process. The parent (`runner.ts`) spawns
 * `process.execPath [this-loader, absoluteHookFile]`, writes the ONE hook
 * envelope JSON to stdin, and parses stdout with the SAME
 * `parseAfterHookOutput` (`{instructions:string}` or `{}`) as stdio hooks.
 *
 * Contract with the hook module:
 * - The module MUST `export default` a function (async OK) receiving the
 *   full envelope as its ONE argument. Input ONLY via that argument:
 *   reading stdin or writing protocol output from module code is
 *   UNSUPPORTED — this loader owns both streams.
 * - The awaited return value is serialised once to stdout. `undefined` is
 *   INVALID (not a no-op); thrown imports/handlers, circular/BigInt
 *   returns, and write errors exit nonzero with a short stderr line —
 *   never a success `{}` on an error.
 * - Module `console.log` is NOT swallowed: it lands on child stdout, makes
 *   the output invalid, and the parent parser rejects it — hook chatter
 *   can never become an instruction and never leaks to parent stdout.
 *
 * Trust honesty: the entry-file hash approves the whole import graph
 * (changing an imported module alone does NOT invalidate entry trust).
 * This child is isolation from CLI memory/stdio, NOT an OS sandbox: HOME,
 * the filesystem, the network, and spawned processes stay available.
 *
 * Node built-ins only. No runtime import of CLI internals or packages.
 * The hook path MUST be absolute; `pathToFileURL` carries spaces, Unicode,
 * `#`, `?`, and `%` through the dynamic import.
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/** Cap on the stdin envelope read — envelopes are small; anything larger is a bug. */
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

function fail(reason) {
  // Bounded, single-line, stderr-only: stdout stays byte-clean so the
  // parent never parses a loader diagnostic as hook output.
  process.stderr.write(`hook-loader: ${reason}\n`);
  process.exit(1);
}

async function readStdin() {
  let bytes = 0;
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_ENVELOPE_BYTES) fail("HOOK_ENVELOPE_TOO_LARGE");
    text += chunk;
  }
  return text;
}

async function main() {
  const hookPath = process.argv[2];
  if (!hookPath || !isAbsolute(hookPath)) {
    fail("HOOK_LOADER_USAGE (absolute hook file path required)");
  }

  const raw = await readStdin();
  let envelope;
  try {
    // Strict one-document parse: trailing garbage after the JSON throws.
    envelope = JSON.parse(raw.trim());
  } catch {
    fail("HOOK_BAD_ENVELOPE (stdin was not one JSON document)");
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    fail("HOOK_BAD_ENVELOPE (stdin was not one JSON object)");
  }

  let mod;
  try {
    mod = await import(pathToFileURL(hookPath).href);
  } catch (err) {
    fail(`HOOK_IMPORT_FAILED (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof mod.default !== "function") {
    fail("HOOK_NO_DEFAULT_EXPORT (module must export default a function)");
  }

  let result;
  try {
    result = await mod.default(envelope);
  } catch (err) {
    fail(`HOOK_HANDLER_FAILED (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof result === "undefined") {
    fail("HOOK_BAD_OUTPUT (module returned undefined — return {} for no-op)");
  }
  let out;
  try {
    out = JSON.stringify(result);
  } catch {
    fail("HOOK_BAD_OUTPUT (return value is not JSON-serializable)");
  }
  if (typeof out !== "string") {
    fail("HOOK_BAD_OUTPUT (return value is not JSON-serializable)");
  }
  try {
    // Await stdout flush: never exit(0) before the document is out, so the
    // parent cannot read a truncated frame.
    await new Promise((resolvePromise, rejectPromise) => {
      process.stdout.write(`${out}\n`, (err) => {
        if (err) rejectPromise(err);
        else resolvePromise(undefined);
      });
    });
  } catch {
    fail("HOOK_STDOUT_FAILED (could not write result)");
  }
}

await main();
