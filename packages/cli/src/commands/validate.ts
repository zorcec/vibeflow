import { readFileSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import chalk from "chalk";
import { validateHtml } from "../core/contract.js";
import { extractProtoIds, findHtmlFiles } from "../core/html-parser.js";
import type { DirectoryValidationResult, ValidationResult } from "../core/types.js";

export function validateFile(
  filePath: string,
  previousFile?: string,
): ValidationResult {
  const absPath = resolve(filePath);
  const html = readFileSync(absPath, "utf-8");

  let previousIds: string[] | undefined;
  if (previousFile) {
    const prevHtml = readFileSync(resolve(previousFile), "utf-8");
    previousIds = extractProtoIds(prevHtml);
  }

  const result = validateHtml(html, previousIds);

  if (result.valid) {
    // Stryker disable once StringLiteral: display message for validation result
    console.log(chalk.green("✓ Validation passed"));
  } else {
    // Stryker disable once StringLiteral: display message for validation result
    console.log(chalk.red("✗ Validation failed"));
  }

  for (const issue of result.issues) {
    const icon = issue.type === "error" ? chalk.red("✗") : chalk.yellow("⚠");
    // Stryker disable once StringLiteral: display message for validation issue
    console.log(`  ${icon} ${issue.message}`);
  }

  // Stryker disable once StringLiteral: display message for element count
  console.log(chalk.dim(`  Elements with IDs: ${result.stats.elementsWithIds}`));

  return result;
}

export function validateDirectory(dirPath: string): DirectoryValidationResult {
  const absPath = resolve(dirPath);
  const htmlFiles = findHtmlFiles(absPath);

  if (htmlFiles.length === 0) {
    throw new Error(`No HTML files found in directory: ${absPath}`);
  }

  const fileResults: Record<string, ValidationResult> = {};
  // Map proto-id → list of filenames that contain it — for cross-file dup detection
  const globalIdMap = new Map<string, string[]>();

  for (const file of htmlFiles) {
    const html = readFileSync(file, "utf-8");
    const result = validateHtml(html);
    const name = basename(file);
    fileResults[name] = result;

    for (const id of extractProtoIds(html)) {
      const existing = globalIdMap.get(id) ?? [];
      existing.push(name);
      globalIdMap.set(id, existing);
    }
  }

  // Cross-file duplicate detection
  const crossFileIssues = [];
  for (const [id, files] of globalIdMap) {
    if (files.length > 1) {
      crossFileIssues.push({
        type: "error" as const,
        // Stryker disable once StringLiteral: display message for cross-file duplicate
        message: `data-vibeflow-id="${id}" appears in multiple files: ${files.join(", ")}`,
        element: id,
      });
    }
  }

  const filesWithErrors = Object.values(fileResults).filter(
    (r) => !r.valid,
  ).length + (crossFileIssues.length > 0 ? 1 : 0);

  const filesWithWarnings = Object.values(fileResults).filter(
    (r) => r.valid && r.issues.length > 0,
  ).length;

  const valid = filesWithErrors === 0;

  // Print summary
  const dir = basename(absPath);
  if (valid) {
    // Stryker disable once StringLiteral: display message for directory validation result
    console.log(chalk.green(`✓ Directory validation passed (${htmlFiles.length} files)`));
  } else {
    // Stryker disable once StringLiteral: display message for directory validation result
    console.log(chalk.red(`✗ Directory validation failed (${htmlFiles.length} files)`));
  }

  for (const [name, result] of Object.entries(fileResults)) {
    const icon = result.valid ? chalk.green("✓") : chalk.red("✗");
    // Stryker disable once StringLiteral: display message for file validation result
    console.log(`  ${icon} ${name}`);
    for (const issue of result.issues) {
      const issueIcon = issue.type === "error" ? chalk.red("  ✗") : chalk.yellow("  ⚠");
      // Stryker disable once StringLiteral: display message for file validation issue
      console.log(`${issueIcon} ${issue.message}`);
    }
  }

  for (const issue of crossFileIssues) {
    // Stryker disable once StringLiteral: display message for cross-file issue
    console.log(`  ${chalk.red("✗")} [cross-file] ${issue.message}`);
  }

  return {
    valid,
    fileResults,
    crossFileIssues,
    stats: {
      filesChecked: htmlFiles.length,
      filesWithErrors,
      filesWithWarnings,
    },
  };
}

export function isDirectory(targetPath: string): boolean {
  try {
    return statSync(resolve(targetPath)).isDirectory();
  } catch {
    return false;
  }
}
