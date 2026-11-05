/**
 * Shipped hook runtime utility (owner ticket c478fd86).
 *
 * `readEnvelope()` / `reply()` / `log()` so authors drop the hand-rolled
 * stdin boilerplate every shipped default repeats. No templating, no
 * expression evaluation: this module moves bytes, it never interprets
 * them — the parent parser stays the only validator (bad shapes still
 * fail `HOOK_BAD_OUTPUT` / `HOOK_BEFORE_MALFORMED` exactly as before).
 *
 * Resolution (works under npx/global where package-name imports do not
 * resolve): the runner injects ONE env var into every hook child,
 * `VIBEFLOW_HOOK_RUNTIME=<abs path to this file in dist/hooks/>`, so a
 * hook does `await import(process.env.VIBEFLOW_HOOK_RUNTIME)`. Where the
 * project has the CLI installed, the `@vibeflow-tools/cli/hooks/runtime`
 * subpath export resolves instead. Both name the same file.
 *
 * ```js
 * // .vibeflow-hooks/tasks.after.mjs (stdio)
 * const { readEnvelope, reply, log } = await import(process.env.VIBEFLOW_HOOK_RUNTIME);
 * const envelope = await readEnvelope();
 * log("saw", envelope.activity);
 * reply(envelope.activity === "task.update" ? { instructions: "review it" } : {});
 * ```
 *
 * Node built-ins only. Shipped verbatim as `dist/hooks/hook-runtime.mjs`
 * (+ handwritten `hook-runtime.d.ts`) by `scripts/build-atomic.mjs`.
 */
import { format } from "node:util";

/** Cap on the stdin envelope read — envelopes are small; anything larger is a bug. */
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

async function readStdin() {
  let bytes = 0;
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_ENVELOPE_BYTES) {
      throw new Error("HOOK_ENVELOPE_TOO_LARGE");
    }
    text += chunk;
  }
  return text;
}

/**
 * Read the ONE hook envelope JSON document from stdin. Rejects on empty
 * stdin, trailing garbage, or a non-object document — the caller (and
 * only the caller) decides the failure policy.
 */
export async function readEnvelope() {
  const raw = await readStdin();
  const envelope = JSON.parse(raw.trim());
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("HOOK_BAD_ENVELOPE (stdin was not one JSON object)");
  }
  return envelope;
}

/**
 * Write the single JSON document to stdout (plus `\n`). Pass an
 * after-result (`{instructions}` / `{}`) or a before-decision
 * (`{allow, ...}`) — this function serialises, it never validates or
 * coerces; the parent parser still rejects bad shapes. Throws on
 * circular/unserializable values rather than writing half a document.
 */
export function reply(result) {
  if (typeof result === "undefined") {
    throw new Error("HOOK_BAD_OUTPUT (reply received undefined — pass {} for no-op)");
  }
  const out = JSON.stringify(result);
  if (typeof out !== "string") {
    throw new Error("HOOK_BAD_OUTPUT (reply value is not JSON-serializable)");
  }
  process.stdout.write(`${out}\n`);
}

/**
 * Diagnostics line to stderr (`util.format` semantics, like console).
 * The runner prefixes child stderr with `hook <tool>:` and byte-caps it.
 */
export function log(...args) {
  process.stderr.write(`${format(...args)}\n`);
}
