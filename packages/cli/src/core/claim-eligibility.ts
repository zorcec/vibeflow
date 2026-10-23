/**
 * Shared agent-claim eligibility selector (ticket 6452504d, parent e7482da5).
 *
 * ONE read-only policy for "which task would `--next` / `claim_next_task`
 * take": the atomic local primitive (`claimNextTaskAtomic` in
 * `core/tasks.ts`) and its read-only preview (`LocalTaskStore.previewClaim`
 * in `core/task-store.ts`) both select through here, so the preview can no
 * longer name a task the live call skips. The preview discrepancy that used
 * to live beside the port boundary (preview ignored unfinished blockers)
 * is fixed by construction: there is only one selector to fix.
 *
 * Selection order (exact, pinned by `tests/unit/claim-eligibility.test.ts`):
 *  1. pool = `todo` tasks matching the type/user/tag filters (exact match —
 *     the local contract; no case-folding without explicit approval);
 *  2. with `rootsOnly`, only ROOTS are candidates (a parented task is never
 *     one) — otherwise eligible roots AND eligible children compete in ONE
 *     priority-then-created order (a Critical child beats a Medium root in
 *     a single call; ticket `tasks-root-only` pins this). Strict roots-first
 *     lives one level up: the operation claims `rootsOnly` first and only
 *     falls back on null, so the operation never takes a child while an
 *     eligible root exists — and the preview mirrors that two-phase shape
 *     through this same selector;
 *  3. without `rootsOnly`, a child is eligible only when its chain is LIVE
 *     (every ancestor todo/in-progress/review; dangling links and cycles
 *     are never claimable), unless `allowInactiveParentChain` opts in;
 *  4. a candidate blocked by unfinished work (`blocks` link to anything but
 *     `done` — `review` is NOT done) is never eligible, root or child;
 *  5. order is priority-then-created ascending with deterministic ties.
 *
 * Pure: takes the board snapshot, returns the pick. Locking, re-reading and
 * writing stay with the caller (the file lock in `claimNextTaskAtomic`) —
 * this module never touches the filesystem.
 */
import {
  getParentId,
  getUnfinishedBlockers,
  isBlockedByUnfinishedWork,
  isChildTask,
  isParentChainActive,
} from "./tasks.js";
import { compareTasksByPriorityThenCreated } from "./types.js";
import type { Task } from "./types.js";

/** Filters the selector applies, in MCP vocabulary (no synonyms). */
export interface ClaimEligibilityFilter {
  type?: string;
  user?: string;
  tag?: string[];
  /**
   * Only consider ROOT tasks — never a task that has a parent. The owner's
   * decision for `--next`: an agent is given the root unit of work, and the
   * root carries its children, rather than being handed a fragment of one.
   */
  rootsOnly?: boolean;
  /**
   * Allow claiming a todo child whose parent chain is NOT fully active
   * (backlog/done parent, or a dangling link). Default false (owner rule,
   * ticket 4ab7104a): the fallback only hands out children of live work.
   */
  allowInactiveParentChain?: boolean;
}

/** The selector's pick: the task plus how it was reached. */
export interface ClaimSelection<T extends Task = Task> {
  task: T;
  /** True when the pick is a child (live chain, unless inactive chains were allowed). */
  childClaim: boolean;
  /** The sliced child's parent id, for the CHILD_CLAIM notice. */
  parentId: string | null;
}

/** Apply the type/user/tag filters to a todo-only pool (exact matching). */
function applyClaimFilters<T extends Task>(
  pool: T[],
  filter: ClaimEligibilityFilter,
): T[] {
  let out = pool;
  if (filter.type) out = out.filter((t) => t.type === filter.type);
  if (filter.user) out = out.filter((t) => t.author === filter.user);
  if (filter.tag && filter.tag.length > 0) {
    out = out.filter(
      (t) => t.tags && filter.tag!.every((tag) => t.tags!.includes(tag)),
    );
  }
  return out;
}

/**
 * THE read-only eligibility selector. One priority order over every
 * eligible candidate with unfinished-blocker suppression at both levels —
 * the same pick the atomic primitive claims, so preview and live can never
 * disagree. Strict roots-first is a two-phase use of this selector
 * (`rootsOnly` first, fallback on null), owned by the operation layer.
 */
export function selectClaimCandidate<T extends Task>(
  allTasks: T[],
  filter: ClaimEligibilityFilter = {},
): ClaimSelection<T> | null {
  const pool = applyClaimFilters(
    allTasks.filter((t) => t.status === "todo"),
    filter,
  );
  // One priority order over every eligible candidate — exactly the old
  // primitive's semantics: roots need no ancestry check, children need a
  // live chain (owner rule, ticket 4ab7104a) unless the caller opts into
  // inactive chains, `rootsOnly` excludes children outright, and a
  // candidate held by an unfinished gate is never eligible at either level.
  // Strict roots-first lives one level up (the operation claims `rootsOnly`
  // first and falls back on null; the preview mirrors that two-phase shape
  // through this same selector).
  const eligible = pool
    .filter((t) => {
      if (isChildTask(t)) {
        if (filter.rootsOnly) return false;
        if (
          !filter.allowInactiveParentChain &&
          !isParentChainActive(allTasks, t)
        )
          return false;
      }
      return !isBlockedByUnfinishedWork(t, allTasks);
    })
    .sort(compareTasksByPriorityThenCreated);
  const first = eligible[0];
  if (!first) return null;
  if (!isChildTask(first))
    return { task: first, childClaim: false, parentId: null };
  return {
    task: first,
    childClaim: true,
    parentId: getParentId(first) ?? null,
  };
}

/** One blocked candidate: the task plus the unfinished gates holding it. */
export interface BlockedClaimEntry<T extends Task = Task> {
  task: T;
  blockers: Task[];
}

/** One stranded candidate: a todo child no claim will ever take. */
export interface StrandedClaimEntry {
  id: string;
  title: string;
  parentId: string | null;
  parentTitle: string;
  parentStatus: string | null;
}

/**
 * Filter-matching todo tasks held by unfinished gates. Computed AFTER the
 * claim, so the just-claimed task (now in-progress) is excluded and the
 * remainder is exactly what `--next` refused to hand out. Display context
 * only — eligibility itself lives in `selectClaimCandidate`.
 */
export function collectBlockedCandidates<T extends Task>(
  allTasks: T[],
  filter: ClaimEligibilityFilter = {},
): Array<BlockedClaimEntry<T>> {
  return applyClaimFilters(
    allTasks.filter((t) => t.status === "todo"),
    filter,
  )
    .map((task) => ({
      task,
      blockers: getUnfinishedBlockers(task, allTasks),
    }))
    .filter((entry) => entry.blockers.length > 0);
}

/**
 * Filter-matching todo children whose parent chain is not live work
 * (backlog/done parent, or a dangling link). Owner rule (ticket 4ab7104a):
 * these are never claimed by the fallback — naming them is what keeps the
 * refusal from reading as invisibility. Display context only.
 */
export function collectStrandedCandidates<T extends Task>(
  allTasks: T[],
  filter: ClaimEligibilityFilter = {},
): StrandedClaimEntry[] {
  const byId = new Map(allTasks.map((t) => [t.id, t] as const));
  return applyClaimFilters(
    allTasks.filter(
      (t) => t.status === "todo" && isChildTask(t) && !isParentChainActive(allTasks, t),
    ),
    filter,
  ).map((t) => {
    const parentId = getParentId(t) ?? null;
    const parent = parentId ? byId.get(parentId) : undefined;
    return {
      id: t.id,
      title: t.title,
      parentId,
      parentTitle: parent?.title ?? "(not found)",
      parentStatus: (parent?.status as string | undefined) ?? null,
    };
  });
}
