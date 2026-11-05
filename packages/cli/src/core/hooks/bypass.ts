/**
 * Pre-hook bypass audit (Stage 2, ticket wla7ci2wzbgaj5dqsrvh1j4o).
 *
 * `--no-verify` skips the pre-gate but never silently: every bypassed
 * gated invocation prints HOOK_BYPASSED on stderr AND appends one JSONL
 * record to the UNIVERSAL LOCAL audit file
 * (`~/.vibeflow/hooks/bypass-audit.log`). Task activity comments are
 * SUPPLEMENTARY only — push/pull/deleted/create-fail have no task to
 * comment on, so the local file is the record of truth, not any single
 * surface. An audit-write failure warns on stderr and NEVER blocks the
 * bypassed command (a logging failure must not become a gate).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface HookBypassRecord {
  ts: string;
  event: string;
  phase: "pre";
  command: string;
  reason: string;
}

export function bypassAuditPath(home: string = homedir()): string {
  return join(home, ".vibeflow", "hooks", "bypass-audit.log");
}

/** Append-only write. Never throws — failure is a stderr warning only. */
export function writeBypassAudit(
  record: Omit<HookBypassRecord, "ts">,
  home?: string,
): void {
  try {
    const path = bypassAuditPath(home);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      JSON.stringify({ ...record, ts: new Date().toISOString() }) + "\n",
      { encoding: "utf8" },
    );
  } catch (err) {
    process.stderr.write(
      `hook bypass audit unwritable (${err instanceof Error ? err.message : String(err)}) — bypass proceeds regardless\n`,
    );
  }
}

/** The HOOK_BYPASSED notice: printed on stderr for every bypassed gate. */
export function formatBypassNotice(event: string, command: string): string {
  return `HOOK_BYPASSED ${event} (pre-gate skipped by --no-verify on ${command}; recorded in bypass-audit.log)`;
}
