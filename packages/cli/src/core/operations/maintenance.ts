/**
 * Local maintenance operations (ticket 4a5f7df6, P5).
 *
 * The shared implementations behind `vibeflow tasks --normalize [--apply]`
 * and `vibeflow tasks --reindex-sort-keys`. Both are visibly local-only
 * (registry requirement `local-only`, no MCP tools): there is no cloud
 * normalization, and re-keying only ever touches `sortKey`/`updated` on
 * disk. They run through the `TaskStore` maintenance ports
 * (`core/task-store.ts`, delegated 1:1 to `core/tasks.ts`) — never a direct
 * `core/tasks.js` import, per the check-5 storage boundary — with a
 * fallback to the local adapter when an injected store carries no
 * maintenance methods.
 *
 * Contracts (each mirrors the inline branch it replaces, byte-for-byte on
 * every pinned envelope):
 *
 * normalizeTaskStore — closed repairs share the read boundary; conflicting
 * data remains quarantined, while unknown ROOT keys are an explicit named
 * strip repair (ticket c0557b6c). Dry-run by default,
 * explicit `apply` heals. `dryRun` OVERRIDES `apply`: a preview never
 * writes, even when both flags ride together (the one deliberate flip off
 * the inline branch, which wrote through `--apply --dry-run` — no pin
 * covered that combination, and every other operation already honours a
 * dry run over a write). A run that PLANNED writes and wrote NONE never
 * touched the store, so it is a refusal (NORMALIZE_WRITE_FAILED, non-zero
 * exit), never an `ok:true` claiming a healing that did not happen. A run
 * that wrote SOME is success with a NORMALIZE_PARTIAL notice naming the
 * unwritten ids; quarantine findings ride notices either way.
 *
 * reindexTaskSortKeys — re-keys only what the comparator cannot order
 * (keyless / ill-formed / whole-store duplicates, per `computeBackfillPlan`;
 * well-formed column-unique keys are anchors and are never touched). Writes
 * are minimal ON PURPOSE via the minimal writer (only `sortKey`, plus the
 * `updated` bump that writer owns): the ordinary write path re-serialises
 * through `normalizeTask`, which drops legacy fields (the singleton
 * `commit` among them — that once cost 18 commit SHAs). Do NOT refactor the
 * write onto `updateTask`. A run that PLANNED patches and wrote NONE is a
 * refusal (REINDEX_WRITE_FAILED) BEFORE the manifest, which records an
 * apply and must never claim one that did not happen. Past that refusal
 * `written > 0`, so a failing post-assert (keyless/dup groups remaining) is
 * a REINDEX_INCOMPLETE notice on a successful run, never a refusal. A
 * re-run is idempotent (zero patches) and must not clobber the manifest of
 * the apply that did the work. No git operations anywhere here.
 *
 * The human blocks (per-change/per-patch lines, manifest path, verified vs
 * incomplete sentences) travel on the returned data — renderers must not
 * re-read any store.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  OperationContext,
  OperationError,
} from "../operations.js";
import { isDryRun } from "../operations.js";
import { localTaskStore } from "../task-store.js";
import { taskReadNotices } from "../task-record-read.js";
import type { TaskReadFinding } from "../task-record-read.js";
import type {
  TaskNormalizePlan,
  TaskNormalizeReport,
} from "../tasks.js";
import { PROTO_DIR } from "../types.js";
import { computeBackfillPlan } from "@vibeflow-tools/ui/kanban";

// ── normalize ────────────────────────────────────────────────────────────

export interface NormalizeTaskStoreInput {
  /** `--apply`: write the plan to the store (preview when absent). */
  apply?: boolean;
  dryRun?: boolean;
}

export interface NormalizeTaskStoreData {
  dryRun: boolean;
  /** Preview plans (dry run) or applied repairs (live). */
  plans: TaskNormalizePlan[];
  unwritten: string[];
  unreadable: string[];
  quarantined: TaskReadFinding[];
  notices: Array<{ code: string; message: string }>;
}

export type NormalizeTaskStoreResult =
  | { ok: true; data: NormalizeTaskStoreData; steps?: never; error?: never }
  | { ok: false; data?: never; steps?: never; error: OperationError };

export async function normalizeTaskStore(
  ctx: OperationContext,
  input: NormalizeTaskStoreInput,
): Promise<NormalizeTaskStoreResult> {
  // No cloud normalization: an injected store without maintenance methods
  // cannot heal anything, so the local adapter answers instead.
  const store = ctx.store ?? localTaskStore;
  const plan: TaskNormalizeReport = store.planNormalize
    ? await store.planNormalize(ctx.projectDir)
    : await localTaskStore.planNormalize(ctx.projectDir);
  // A preview never writes, even when `--apply` rides along: dryRun
  // overrides apply (the one deliberate flip — see the module doc).
  const effectiveApply = input.apply === true && !isDryRun(ctx, input);
  if (!effectiveApply) {
    return {
      ok: true,
      data: {
        dryRun: true,
        plans: plan.changes,
        unwritten: [],
        unreadable: plan.unreadable,
        quarantined: plan.quarantined,
        notices: taskReadNotices(plan.quarantined),
      },
    };
  }

  const result = store.applyNormalize
    ? await store.applyNormalize(ctx.projectDir)
    : await localTaskStore.applyNormalize(ctx.projectDir);
  const planned = result.applied.length + result.unwritten.length;
  // The plan named writes and NONE landed: the run touched nothing, so
  // reporting ok:true would claim a healing that did not happen.
  if (planned > 0 && result.applied.length === 0) {
    return {
      ok: false,
      error: {
        code: "NORMALIZE_WRITE_FAILED",
        message: `Normalize wrote 0 of ${planned} planned change(s) — no task file was changed.`,
        suggestion: `Each write needs a readable task file carrying the planned key; unwritable: ${result.unwritten.join(", ")}`,
      },
    };
  }
  const notices: Array<{ code: string; message: string }> =
    result.unwritten.length > 0
      ? [
          {
            code: "NORMALIZE_PARTIAL",
            message: `Normalize wrote ${result.applied.length} of ${planned} planned change(s); unwritten: ${result.unwritten.join(", ")}.`,
          },
        ]
      : [];
  notices.push(...taskReadNotices(result.quarantined));
  return {
    ok: true,
    data: {
      dryRun: false,
      plans: result.applied,
      unwritten: result.unwritten,
      unreadable: result.unreadable,
      quarantined: result.quarantined,
      notices,
    },
  };
}

// ── reindex ──────────────────────────────────────────────────────────────

export interface ReindexTaskSortKeysInput {
  dryRun?: boolean;
}

export interface ReindexPatchView {
  id: string;
  title: string;
  oldKey: string | null;
  newKey: string;
}

export interface ReindexTaskSortKeysData {
  dryRun: boolean;
  patches: ReindexPatchView[];
  written: number;
  unwritten: string[];
  manifestPath: string;
  keyless: number;
  openKeyless: number;
  dupOffenders: string[];
  reindexVerified: boolean;
  notices: Array<{ code: string; message: string }>;
}

export type ReindexTaskSortKeysResult =
  | { ok: true; data: ReindexTaskSortKeysData; steps?: never; error?: never }
  | { ok: false; data?: never; steps?: never; error: OperationError };

export async function reindexTaskSortKeys(
  ctx: OperationContext,
  input: ReindexTaskSortKeysInput,
): Promise<ReindexTaskSortKeysResult> {
  const store = ctx.store ?? localTaskStore;
  const allTasks = await store.listTasks(ctx.projectDir);
  // Reproduce exactly what the board renders: the server maps `created` ->
  // `createdAt` and leaves `updatedAt` unset on initial load, so this is
  // the order compareTaskOrder sees at render time.
  const view = allTasks.map((t) => ({
    id: t.id,
    status: t.status,
    sortKey: t.sortKey,
    createdAt: t.created,
  }));
  const patches = computeBackfillPlan(view);
  const titles = new Map(allTasks.map((t) => [t.id, t.title]));
  const oldKeys = new Map(allTasks.map((t) => [t.id, t.sortKey]));
  const manifest = patches.map((p) => ({
    id: p.id,
    oldKey: oldKeys.get(p.id) ?? null,
    newKey: p.sortKey,
  }));
  const views: ReindexPatchView[] = manifest.map((m) => ({
    ...m,
    title: titles.get(m.id) ?? "",
  }));
  // The manifest path is always reported (even when nothing lands), exactly
  // like the inline branch — but only written when the run changed
  // something, so a no-op re-run never clobbers the record of the apply.
  const manifestPath = join(
    ctx.projectDir,
    PROTO_DIR,
    "reindex-sort-keys-manifest.json",
  );

  if (isDryRun(ctx, input)) {
    return {
      ok: true,
      data: {
        dryRun: true,
        patches: views,
        written: 0,
        unwritten: [],
        manifestPath,
        keyless: 0,
        openKeyless: 0,
        dupOffenders: [],
        reindexVerified: false,
        notices: [],
      },
    };
  }

  const writeSortKey = store.writeSortKey?.bind(store) ??
    localTaskStore.writeSortKey.bind(localTaskStore);
  let written = 0;
  const unwritten: string[] = [];
  for (const p of patches) {
    // Write minimally ON PURPOSE (see the module doc): never updateTask.
    if (await writeSortKey(ctx.projectDir, p.id, p.sortKey)) written++;
    else unwritten.push(p.id);
  }

  // Two outcomes, not one. The minimal writer can compute a patch and then
  // decline to write it (a task file with neither a `sortKey` nor an
  // `updated` field has nothing to edit in place), so a run that PLANNED
  // writes and wrote NONE never touched the store. Reporting that as
  // `ok:true` would tell a consumer the re-keying landed when nothing did
  // — the one lie this contract must not make. Refuse BEFORE the manifest,
  // which records an apply that did not happen.
  if (patches.length > 0 && written === 0) {
    return {
      ok: false,
      error: {
        code: "REINDEX_WRITE_FAILED",
        message: `Reindex wrote 0 of ${patches.length} planned sortKey patch(es) — no task file was changed.`,
        suggestion: `Each write needs a readable task file carrying a "sortKey" or "updated" field to edit in place; unwritable: ${unwritten.join(", ")}`,
      },
    };
  }

  // Machine-readable manifest (outside tasks/, so it never enters the store
  // listing). No git operations are performed anywhere here. Only written
  // when the run actually changed something: a re-run is idempotent (zero
  // patches) and must not clobber the record of the apply that did the work.
  if (manifest.length > 0) {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), patches: manifest },
        null,
        2,
      ),
      "utf-8",
    );
  }

  // In-command post-assert: no keyless tasks, no same-column dup groups.
  const after = await store.listTasks(ctx.projectDir);
  const keyless = after.filter((t) => !t.sortKey);
  const openKeyless = keyless.filter((t) => t.status !== "done");
  const byStatus = new Map<string, Map<string, number>>();
  for (const t of after) {
    if (!t.sortKey) continue;
    const counts = byStatus.get(t.status) ?? new Map<string, number>();
    counts.set(t.sortKey, (counts.get(t.sortKey) ?? 0) + 1);
    byStatus.set(t.status, counts);
  }
  const dupOffenders: string[] = [];
  for (const [status, counts] of byStatus) {
    for (const [key, n] of counts) {
      if (n > 1) dupOffenders.push(`${status}: ${key} ×${n}`);
    }
  }
  const reindexVerified =
    openKeyless.length === 0 &&
    keyless.length === 0 &&
    dupOffenders.length === 0;

  // Past the refusal above, `written > 0`: the re-keying itself landed, so
  // only the post-assert can fail. That is a NOTICE on a successful run,
  // not a refusal — the exit code stays 0 and `reindexVerified: false`
  // says so.
  const notices: Array<{ code: string; message: string }> = reindexVerified
    ? []
    : [
        {
          code: "REINDEX_INCOMPLETE",
          message: `Reindex incomplete: ${keyless.length} keyless (${openKeyless.length} open), ${dupOffenders.length} same-column duplicate group(s).`,
        },
      ];

  return {
    ok: true,
    data: {
      dryRun: false,
      patches: views,
      written,
      unwritten,
      manifestPath,
      keyless: keyless.length,
      openKeyless: openKeyless.length,
      dupOffenders,
      reindexVerified,
      notices,
    },
  };
}
