/**
 * Tree geometry constants shared by RecursiveChildrenTree and ChildRow.
 *
 * They live outside both components so ChildRow can read the indent step
 * without importing RecursiveChildrenTree (which imports ChildRow) — a
 * hand-copied literal is how the two drifted apart before.
 */

/** Depth indentation per nesting level (px). */
export const TREE_INDENT_PX = 14;

/** Failsafe, not a design limit. */
export const MAX_TREE_DEPTH = 8;
