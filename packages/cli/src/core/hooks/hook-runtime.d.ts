/**
 * Type declarations for the shipped hook runtime utility
 * (`@vibeflow-tools/cli/hooks/runtime` → `dist/hooks/hook-runtime.mjs`,
 * owner ticket c478fd86). Handwritten and copied verbatim by
 * `scripts/build-atomic.mjs` — the `.mjs` source carries no types.
 */
export interface HookRuntimeEnvelope {
  tool: string;
  surface: string;
  phase: "before" | "after";
  activity: string | null;
  payload: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type HookRuntimeAfterResult = { instructions: string } | Record<string, never>;

export type HookRuntimeBeforeDecision =
  | { allow: true; instructions?: string }
  | { allow: false; reason: string; instructions?: string };

/** Read the ONE hook envelope JSON document from stdin. Rejects on bad input. */
export declare function readEnvelope(): Promise<HookRuntimeEnvelope>;
/**
 * Write the single JSON document to stdout. Serialises only — never
 * validates or coerces; the parent parser still rejects bad shapes.
 */
export declare function reply(
  result: HookRuntimeAfterResult | HookRuntimeBeforeDecision,
): void;
/** Diagnostics line to stderr (`util.format` semantics, like console). */
export declare function log(...args: unknown[]): void;
