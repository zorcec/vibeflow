#!/usr/bin/env node
/**
 * Guards two things that break the published package silently:
 *
 * 1. README media that is too large for GitHub's camo proxy.
 *    Both github.com and npmjs.com render README markdown through GitHub's
 *    markdown pipeline, which rewrites every remote <img> to
 *    `camo.githubusercontent.com/<digest>/<hex-url>`. camo refuses any upstream
 *    response longer than CAMO_LENGTH_LIMIT (default 5242880 B) and answers
 *    `404 Content length exceeded`, so the image renders as a broken box. That
 *    is invisible to the CLI's own test suite and to `npm pack`.
 *
 * 2. A tarball that grew because the package `files` list pulled in demo media
 *    (the 28 MB / 31 MB unpacked incident).
 *
 * Usage (from packages/cli):
 *
 *   node scripts/check-readme-assets.mjs            # static checks only
 *   node scripts/check-readme-assets.mjs --online   # + fetch every remote asset
 *   node scripts/check-readme-assets.mjs --json
 *   node scripts/check-readme-assets.mjs --readme other.md --skip-pack --allow-http
 *
 * Exit code 1 when anything fails. `--offline` is the default; the online pass
 * runs in the publish pipeline (deploy/scripts/publish-cli.sh).
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * camo's own default: `content_length_limit = parseInt(process.env.CAMO_LENGTH_LIMIT || 5242880, 10)`
 * (atmos/camo). GitHub runs the same default, so anything above this is a
 * guaranteed broken image on github.com and npmjs.com.
 */
export const CAMO_LIMIT_BYTES = 5_242_880;
/** Stay well clear of the hard limit — prefer warning long before an asset fails. */
export const ASSET_WARN_BYTES = 2_097_152;
/** npm pack budgets: the shipped CLI is ~3.6 MB unpacked today. */
export const PACK_UNPACKED_BUDGET_BYTES = 8 * 1024 * 1024;
export const PACK_SINGLE_FILE_BUDGET_BYTES = 3 * 1024 * 1024;
/** Media in the tarball is always a mistake — the README links the deployed copies. */
const PACK_FORBIDDEN_MEDIA_RX = /\.(gif|mp4|webm|mov|avi|psd)$/i;

const MARKDOWN_IMAGE_RX = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMAGE_RX = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

/** @typedef {{ url: string, alt: string, syntax: "markdown" | "html" }} ReadmeImage */

/**
 * @param {string} markdown
 * @returns {ReadmeImage[]}
 */
export function extractImages(markdown) {
  /** @type {ReadmeImage[]} */
  const out = [];
  for (const m of markdown.matchAll(MARKDOWN_IMAGE_RX)) {
    const url = m[2].replace(/^<|>$/g, "").trim();
    if (url) out.push({ url, alt: m[1].trim(), syntax: "markdown" });
  }
  for (const m of markdown.matchAll(HTML_IMAGE_RX)) {
    const url = m[1].trim();
    if (url) out.push({ url, alt: "", syntax: "html" });
  }
  return out;
}

/**
 * How the README reference will behave on a registry/GitHub page.
 * @param {string} url
 * @param {{ allowHttp?: boolean }} [opts]
 */
export function classifyUrl(url, opts = {}) {
  if (/^data:/i.test(url)) return "inline";
  if (/^https:\/\//i.test(url)) return "remote";
  if (/^\/\//i.test(url)) return "protocol-relative";
  if (/^http:\/\//i.test(url)) {
    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(url);
    return isLocal && opts.allowHttp ? "remote" : "insecure";
  }
  return "relative";
}

/**
 * Verdict for one fetched remote asset.
 * @param {string} url
 * @param {{ status: number, contentType?: string | null, contentLength?: number | null, error?: string | null }} probe
 */
export function evaluateAsset(url, probe) {
  if (probe.error) return { level: "error", reason: `unreachable: ${probe.error}` };
  if (probe.status !== 200) return { level: "error", reason: `HTTP ${probe.status}` };
  const type = (probe.contentType || "").toLowerCase();
  if (type && !type.startsWith("image/")) return { level: "error", reason: `content-type ${type} is not an image` };
  const length = probe.contentLength ?? null;
  if (length === null) return { level: "warn", reason: "no content-length reported — size unverified" };
  if (length > CAMO_LIMIT_BYTES) {
    return {
      level: "error",
      reason: `${length} B exceeds camo's ${CAMO_LIMIT_BYTES} B limit — github.com and npmjs.com will show 'Content length exceeded'`,
    };
  }
  if (length > ASSET_WARN_BYTES) {
    return { level: "warn", reason: `${length} B is over ${ASSET_WARN_BYTES} B (${percent(length, CAMO_LIMIT_BYTES)}% of camo's limit)` };
  }
  return { level: "ok", reason: `${length} B (${percent(length, CAMO_LIMIT_BYTES)}% of camo's limit)` };
}

/**
 * @param {{ unpackedSize?: number, size?: number, files?: Array<{ path: string, size: number }> }} packInfo
 */
export function evaluatePack(packInfo) {
  const errors = [];
  const warnings = [];
  const unpacked = packInfo.unpackedSize ?? 0;
  if (unpacked > PACK_UNPACKED_BUDGET_BYTES) {
    errors.push(`unpacked package is ${mb(unpacked)} MB, budget is ${mb(PACK_UNPACKED_BUDGET_BYTES)} MB`);
  }
  for (const file of packInfo.files ?? []) {
    if (file.size > PACK_SINGLE_FILE_BUDGET_BYTES) {
      errors.push(`${file.path} is ${mb(file.size)} MB, single-file budget is ${mb(PACK_SINGLE_FILE_BUDGET_BYTES)} MB`);
    }
    if (PACK_FORBIDDEN_MEDIA_RX.test(file.path)) {
      errors.push(`${file.path} ships demo media in the tarball — link it from the website instead`);
    }
  }
  return { errors, warnings, unpacked, tarball: packInfo.size ?? 0, fileCount: packInfo.files?.length ?? 0 };
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);
const percent = (a, b) => Math.round((a / b) * 100);

/**
 * Probe one URL without downloading the whole body.
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 */
async function probeUrl(url, fetchImpl) {
  const attempt = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetchImpl(url, { method, redirect: "follow", signal: controller.signal });
      const contentLength = Number(res.headers.get("content-length"));
      if (method === "GET" && res.body) await res.body.cancel().catch(() => {});
      return {
        status: res.status,
        contentType: res.headers.get("content-type"),
        contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
        error: null,
      };
    } catch (err) {
      return { status: 0, contentType: null, contentLength: null, error: err?.message ?? String(err) };
    } finally {
      clearTimeout(timer);
    }
  };
  const head = await attempt("HEAD");
  if (head.error || head.status !== 200 || head.contentLength === null) {
    const get = await attempt("GET");
    // Prefer the GET result when HEAD was inconclusive but GET worked.
    if (!get.error && get.status === 200) return get;
    return head.error ? head : get;
  }
  return head;
}

/**
 * @param {string} readmePath
 * @param {{ online?: boolean, allowHttp?: boolean, fetchImpl?: typeof fetch }} [opts]
 */
export async function checkReadmeAssets(readmePath, opts = {}) {
  const { online = false, allowHttp = false, fetchImpl = fetch } = opts;
  const markdown = readFileSync(readmePath, "utf8");
  const images = extractImages(markdown);
  const errors = [];
  const warnings = [];
  const results = [];

  if (images.length === 0) {
    warnings.push(`${readmePath} references no images at all — is that intentional?`);
  }

  for (const image of images) {
    const kind = classifyUrl(image.url, { allowHttp });
    const entry = { ...image, kind, level: "ok", reason: "" };

    if (kind === "relative") {
      entry.level = "error";
      entry.reason = "relative path — npm and github cannot resolve it, the image will be broken";
    } else if (kind === "protocol-relative") {
      entry.level = "error";
      entry.reason = "protocol-relative URL — use an explicit https:// URL";
    } else if (kind === "insecure") {
      entry.level = "error";
      entry.reason = "plain http:// URL — use https://";
    } else if (kind === "inline") {
      entry.level = "ok";
      entry.reason = "inline data URI";
    } else if (online) {
      const probe = await probeUrl(image.url, fetchImpl);
      const verdict = evaluateAsset(image.url, probe);
      entry.level = verdict.level;
      entry.reason = verdict.reason;
      entry.status = probe.status;
      entry.contentType = probe.contentType;
      entry.contentLength = probe.contentLength;
    } else {
      entry.reason = "size not checked (offline)";
    }

    if (entry.level === "error") errors.push(`${image.url} — ${entry.reason}`);
    if (entry.level === "warn") warnings.push(`${image.url} — ${entry.reason}`);
    results.push(entry);
  }

  return { ok: errors.length === 0, readmePath, images: results, errors, warnings };
}

/**
 * @param {string} packageDir
 * @param {{ packJson?: string }} [opts] `packJson` replays a recorded `npm pack --dry-run --json`
 *   payload (used by the unit test, so the budgets are testable without a build).
 */
export function checkPackSize(packageDir, opts = {}) {
  if (!opts.packJson && !existsSync(path.join(packageDir, "dist"))) {
    return { errors: [], warnings: ["dist/ is missing — pack size not checked (run the build first)"], skipped: true };
  }
  const raw = opts.packJson ? readFileSync(opts.packJson, "utf8") : execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageDir, encoding: "utf8" });
  const [info] = JSON.parse(raw);
  const verdict = evaluatePack(info);
  return {
    ...verdict,
    skipped: false,
    errors: verdict.errors.map((e) => `pack: ${e}`),
    warnings: verdict.warnings,
  };
}

export function formatReport(assetReport, packReport) {
  const lines = [];
  lines.push(`README assets (${assetReport.readmePath})`);
  for (const image of assetReport.images) {
    const mark = image.level === "ok" ? "✔" : image.level === "warn" ? "!" : "✖";
    lines.push(`  ${mark} [${image.kind}] ${image.url}`);
    if (image.reason) lines.push(`      ${image.reason}`);
    if (image.alt) lines.push(`      alt: ${image.alt}`);
  }
  if (packReport) {
    lines.push("");
    lines.push("Package contents");
    if (packReport.skipped) lines.push(`  ! ${packReport.warnings.join("; ")}`);
    else {
      lines.push(`  ✔ tarball ${mb(packReport.tarball)} MB, unpacked ${mb(packReport.unpacked)} MB, ${packReport.fileCount} files`);
    }
  }
  for (const warning of [...assetReport.warnings, ...(packReport?.warnings ?? [])]) lines.push(`  ! ${warning}`);
  for (const error of [...assetReport.errors, ...(packReport?.errors ?? [])]) lines.push(`  ✖ ${error}`);
  lines.push("");
  lines.push(assetReport.ok && (packReport ? packReport.errors.length === 0 : true) ? "✓ README assets and package size are within budget" : "✗ README asset / package size check FAILED");
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(scriptDir, "..");
  const readmePath = path.resolve(valueOf("--readme") ?? path.join(packageDir, "README.md"));
  const online = has("--online") || process.env.README_ASSETS_ONLINE === "1";
  const skipPack = has("--skip-pack");
  const allowHttp = has("--allow-http");

  const assetReport = await checkReadmeAssets(readmePath, { online, allowHttp });
  const packReport = skipPack ? null : checkPackSize(packageDir, { packJson: valueOf("--pack-json") });
  const failed = !assetReport.ok || (packReport ? packReport.errors.length > 0 : false);

  if (has("--json")) {
    console.log(JSON.stringify({ ok: !failed, online, assets: assetReport, pack: packReport }, null, 2));
  } else {
    console.log(formatReport(assetReport, packReport));
    if (!online) console.log("\n(size checks skipped — pass --online to fetch every remote asset)");
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
