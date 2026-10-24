/**
 * Auxiliary local operations (ticket 9c1217b1, P6 increment 1).
 *
 * The shared implementations behind `vibeflow changelog`, `vibeflow openapi`,
 * `vibeflow telemetry ...` and `vibeflow authors link`. All four are
 * visibly local-only (registry requirement `local-only` / `none`, no MCP
 * tools): they read bundled artifacts, local config, or the git-tracked
 * store — never the board, never the network. They run through injected
 * ports so unit tests drive fakes instead of HOME, the bundle layout, or
 * git; `src/index.ts` keeps flag parsing, printing, and the exit code while
 * every decision about WHAT to do lives here.
 *
 * Contracts (each mirrors the inline branch it replaces, byte-for-byte on
 * every pinned envelope):
 *
 * getChangelog — selects the newest packed section, or every section with
 * `all`. The terminal formatting stays `formatSectionForTerminal` (via
 * `changelogText`), so the returned `text` is print-verbatim; `empty` marks
 * the "no changelog for this installation" branch the renderer owns.
 *
 * getOpenApiDocument — selects the bundled JSON or YAML spec twin. The raw
 * bytes ride `content`; the EPIPE-quiet stdout write stays in the renderer
 * (transport plumbing, not a domain decision).
 *
 * manageTelemetry — one action enum (`enable` / `disable` / `status`).
 * `disable` and `enable` mutate only the local config file; `status` never
 * writes. `envOverride` reports the VIBEFLOW_TELEMETRY=0 escape hatch the
 * renderer prints.
 *
 * linkCommitAuthors — runs the enrichment from `commands/authors.ts`
 * through an injectable service (default: the real `authorsLink`). The
 * git-availability refusal, dry-run purity, and never-overwrite-conflicts
 * policy all live in that service; the operation contributes the request
 * shape (`dryRun` passthrough, project directory) and the result envelope.
 * The renderer owns the JSON/human print and the exit-1-on-no-git rule.
 */
import type { OperationContext } from "../operations.js";
import {
  changelogText,
  readChangelogContent,
} from "../changelog.js";
import { OPENAPI_JSON, OPENAPI_YAML } from "../../server/openapi.gen.js";
import {
  getTelemetryStatus,
  setTelemetryEnabled,
} from "../../telemetry.js";
import type { AuthorsLinkResult } from "../../commands/authors.js";

// ── changelog ────────────────────────────────────────────────────────────

export interface GetChangelogInput {
  /** `--all`: every packed section instead of the newest one. */
  all?: boolean;
  /** Injected for tests; defaults to reading the bundled CHANGELOG.md. */
  readContent?: () => string | null;
}

export interface GetChangelogData {
  all: boolean;
  /** Terminal-formatted selection, print-verbatim (empty when none). */
  text: string;
  /** True when no changelog was found for this installation. */
  empty: boolean;
}

// Infallible leaf: every input below has a total function behind it (the
// content reader never throws, the spec twins are constants, the telemetry
// config helpers and the enrichment service report their own failures as
// data), so success is the only arm — exactly like the inline branches,
// which never produced a refusal envelope for these commands.
export type GetChangelogResult = { ok: true; data: GetChangelogData };

export async function getChangelog(
  _ctx: OperationContext,
  input: GetChangelogInput,
): Promise<GetChangelogResult> {
  const content = (input.readContent ?? readChangelogContent)() ?? "";
  const text = changelogText(content, { all: input.all === true });
  return {
    ok: true,
    data: {
      all: input.all === true,
      text,
      empty: text === "",
    },
  };
}

// ── openapi ──────────────────────────────────────────────────────────────

export interface GetOpenApiDocumentInput {
  /** `--yaml`: the YAML twin instead of JSON. */
  yaml?: boolean;
  /** Injected for tests; defaults to the bundled spec twins. */
  readSpec?: (yaml: boolean) => string;
}

export interface GetOpenApiDocumentData {
  yaml: boolean;
  /** Raw spec bytes, written verbatim (no envelope, no colour). */
  content: string;
}

export type GetOpenApiDocumentResult = { ok: true; data: GetOpenApiDocumentData };

export async function getOpenApiDocument(
  _ctx: OperationContext,
  input: GetOpenApiDocumentInput,
): Promise<GetOpenApiDocumentResult> {
  const yaml = input.yaml === true;
  const content = (input.readSpec ?? defaultOpenApiSpec)(yaml);
  return { ok: true, data: { yaml, content } };
}

function defaultOpenApiSpec(yaml: boolean): string {
  return yaml ? OPENAPI_YAML : OPENAPI_JSON;
}

// ── telemetry ────────────────────────────────────────────────────────────

export type TelemetryAction = "enable" | "disable" | "status";

export interface ManageTelemetryInput {
  action: TelemetryAction;
  /** Injected for tests; defaults to the real telemetry config. */
  getStatus?: () => { enabled: boolean; anonymousId: string | null };
  /** Injected for tests; defaults to writing the real telemetry config. */
  setEnabled?: (enabled: boolean) => void;
  /** Injected for tests; defaults to reading VIBEFLOW_TELEMETRY. */
  isEnvDisabled?: () => boolean;
}

export interface ManageTelemetryData {
  action: TelemetryAction;
  enabled: boolean;
  anonymousId: string | null;
  /** True when VIBEFLOW_TELEMETRY=0 forces telemetry off. */
  envOverride: boolean;
}

export type ManageTelemetryResult = { ok: true; data: ManageTelemetryData };

export async function manageTelemetry(
  _ctx: OperationContext,
  input: ManageTelemetryInput,
): Promise<ManageTelemetryResult> {
  const setEnabled = input.setEnabled ?? setTelemetryEnabled;
  if (input.action === "enable") setEnabled(true);
  else if (input.action === "disable") setEnabled(false);
  // `status` never writes: the only mutation paths are the two above.
  const { enabled, anonymousId } = (input.getStatus ?? getTelemetryStatus)();
  return {
    ok: true,
    data: {
      action: input.action,
      enabled,
      anonymousId,
      envOverride: (input.isEnvDisabled ?? defaultIsEnvDisabled)(),
    },
  };
}

function defaultIsEnvDisabled(): boolean {
  return process.env.VIBEFLOW_TELEMETRY === "0";
}

// ── authors link ─────────────────────────────────────────────────────────

export interface LinkCommitAuthorsInput {
  /** `--dry-run`: report the counts, write nothing. */
  dryRun?: boolean;
  /**
   * Injected enrichment service; defaults to the real `authorsLink`
   * (git-backed, store-backed). Fakes assert the request the operation
   * builds without touching git or the store.
   */
  runEnrichment?: (
    projectDir: string,
    opts: { dryRun?: boolean; resolveEmail?: (sha: string) => string | null },
  ) => AuthorsLinkResult | Promise<AuthorsLinkResult>;
  /** Forwarded to the service; injected git resolver for service tests. */
  resolveEmail?: (sha: string) => string | null;
}

export interface LinkCommitAuthorsData {
  dryRun: boolean;
  report: AuthorsLinkResult;
}

export type LinkCommitAuthorsResult = { ok: true; data: LinkCommitAuthorsData };

export async function linkCommitAuthors(
  ctx: OperationContext,
  input: LinkCommitAuthorsInput,
): Promise<LinkCommitAuthorsResult> {
  const run = input.runEnrichment ?? defaultRunEnrichment;
  const report = await run(ctx.projectDir, {
    ...(input.dryRun === true ? { dryRun: true as const } : {}),
    ...(input.resolveEmail !== undefined
      ? { resolveEmail: input.resolveEmail }
      : {}),
  });
  return {
    ok: true,
    data: { dryRun: input.dryRun === true, report },
  };
}

async function defaultRunEnrichment(
  projectDir: string,
  opts: { dryRun?: boolean; resolveEmail?: (sha: string) => string | null },
): Promise<AuthorsLinkResult> {
  // Loaded on demand: a top-level import would run git/fs module init for
  // every command (operations.ts is statically imported by the CLI entry),
  // which measurably delays the CLI's first output — the same reason the
  // renderer keeps its format-helper import dynamic.
  const { authorsLink } = await import("../../commands/authors.js");
  return authorsLink(projectDir, opts);
}
