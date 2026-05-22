import { extractProtoIds, hasExternalDependencies, isValidHtml } from "./html-parser.js";
import type { ValidationIssue, ValidationResult } from "./types.js";

// CDN patterns that are explicitly allowed in prototypes (UI libs, fonts, icons)
const ALLOWED_CDN_PATTERNS = [
  "cdn.tailwindcss.com",
  "tailwindcss.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.lucide.dev",
  "esm.sh",
  "skypack.dev",
];

function isAllowedCdn(url: string): boolean {
  return ALLOWED_CDN_PATTERNS.some((pattern) => url.includes(pattern));
}

export function validateHtml(
  html: string,
  previousIds?: string[],
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isValidHtml(html)) {
    issues.push({ type: "error", message: "File is not valid HTML" });
    return {
      valid: false,
      issues,
      stats: {
        elementsWithIds: 0,
      },
    };
  }

  const currentIds = extractProtoIds(html);

  if (previousIds) {
    for (const id of previousIds) {
      if (!currentIds.includes(id)) {
        issues.push({
          type: "error",
          message: `Missing data-vibeflow-id="${id}" — element was removed or id changed`,
          element: id,
        });
      }
    }
  }

  const externals = hasExternalDependencies(html);
  for (const ext of externals) {
    const url = ext.split(": ")[1] ?? "";
    if (!isAllowedCdn(url)) {
      issues.push({
        type: "warning",
        message: `Non-CDN external dependency: ${ext} — use Tailwind/jsDelivr/unpkg instead`,
      });
    }
  }

  if (currentIds.length === 0) {
    issues.push({
      type: "warning",
      message:
        "No data-vibeflow-id attributes found — element targeting may not work reliably",
    });
  }

  const duplicateIds = currentIds.filter(
    (id, i) => currentIds.indexOf(id) !== i,
  );
  for (const dup of [...new Set(duplicateIds)]) {
    issues.push({
      type: "error",
      message: `Duplicate data-vibeflow-id="${dup}"`,
      element: dup,
    });
  }

  const hasErrors = issues.some((i) => i.type === "error");

  return {
    valid: !hasErrors,
    issues,
    stats: {
      elementsWithIds: currentIds.length,
    },
  };
}
