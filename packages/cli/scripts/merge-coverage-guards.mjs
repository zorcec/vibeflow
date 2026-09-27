/**
 * The honesty guards for `scripts/merge-coverage.mjs`.
 *
 * The merge joins two coverage maps, and a join of ONE side is still a join as
 * far as the report is concerned: the script would print a "merged" number that
 * is really the unit-only number, with a column header claiming otherwise. That
 * is the exact dishonesty this tooling was added to remove, so every way the
 * second side can fail to arrive is a refusal with a non-zero exit, not a
 * quietly smaller number.
 *
 * Split into its own module so the unit suite can reach it. `merge-coverage.mjs`
 * does all of its work at import time (it reads maps, converts bundles, writes a
 * report), so a test that imported it would run the whole pipeline instead of
 * the checks.
 */

/** Every refusal starts with this, so the failure is unmistakable in a CI log. */
export const REFUSAL_PREFIX = "merge-coverage: refusing to report a merged number";

/** A location covered by the unit pass or the e2e pass, in either map. */
function coveredStatements(fileEntry) {
  if (!fileEntry) return 0;
  let covered = 0;
  for (const [id, count] of Object.entries(fileEntry.s ?? {})) {
    if ((count ?? 0) > 0) covered++;
  }
  return covered;
}

/**
 * Keys that LOOK like the subject but are spelled differently — the shape a
 * path-spelling mismatch takes (`…/packages/ui/src/index.ts` next to
 * `…/packages/cli/src/index.ts`). Named in the refusal, because "the e2e side
 * did not measure the file" is a much harder error to chase than "the e2e side
 * measured a different file with the same basename".
 */
function nearMisses(files, subject) {
  const base = subject.split("/").pop();
  return files.filter((f) => f !== subject && f.endsWith(`/${base}`));
}

/**
 * Refuses to report unless BOTH sides are present and the e2e side measured
 * the subject.
 *
 * @param {object} facts
 * @param {string} facts.subject             the file the pipeline exists for
 * @param {number} facts.rawE2eFiles         `*.json` files found in the e2e dir
 * @param {number} facts.executedBundleFiles bundle files the e2e children ran
 * @param {string[]} facts.remappedFiles     e2e map keys, after source-mapping
 * @param {string[]} facts.unitFiles         unit map keys
 * @param {string} [facts.unitKey]           the subject's key in the unit map
 * @param {string} [facts.e2eKey]            the subject's key in the e2e map
 * @param {object} [facts.e2eEntry]          the subject's istanbul entry, e2e side
 * @throws {Error} on the first violated rule; returns undefined when the pair
 *   is complete enough to merge.
 */
export function assertMergeIsHonest(facts) {
  const {
    subject,
    rawE2eFiles,
    executedBundleFiles,
    remappedFiles,
    unitFiles,
    e2eFiles,
    unitKey,
    e2eKey,
    e2eEntry,
  } = facts;

  if (rawE2eFiles === 0) {
    throw new Error(
      `${REFUSAL_PREFIX}: the e2e coverage dir held no *.json file, so the e2e ` +
        `pass never ran. Run it with NODE_V8_COVERAGE=<dir> and ` +
        `VIBEFLOW_E2E_CLI=<coverage build>/index.js (see test:coverage:e2e).`,
    );
  }
  if (executedBundleFiles === 0) {
    throw new Error(
      `${REFUSAL_PREFIX}: none of the ${rawE2eFiles} e2e coverage file(s) ` +
        `executed anything from the coverage build, so the second side is empty. ` +
        `Check that --cli-dir points at the built .coverage-cli/ directory.`,
    );
  }
  if (remappedFiles.length === 0) {
    throw new Error(
      `${REFUSAL_PREFIX}: the e2e pass remapped to no src/** file, so there is ` +
        `nothing to merge. The coverage build must be unminified and emit source ` +
        `maps (tsup.coverage.config.ts).`,
    );
  }

  if (!unitKey && !e2eKey) {
    throw new Error(
      `${REFUSAL_PREFIX}: neither coverage pass produced an entry for ${subject} — ` +
        `the coverage build no longer maps back to it.`,
    );
  }
  if (unitKey && !e2eKey) {
    throw new Error(
      `${REFUSAL_PREFIX}: ${subject} is in the unit map but not in the e2e map. ` +
        `A unit-only merge reports the unit number under a "merged" heading.` +
        nearMiss(e2eFiles, subject),
    );
  }
  if (!unitKey && e2eKey) {
    throw new Error(
      `${REFUSAL_PREFIX}: ${subject} is in the e2e map but not in the unit map.` +
        nearMiss(unitFiles, subject),
    );
  }

  if (coveredStatements(e2eEntry) === 0) {
    throw new Error(
      `${REFUSAL_PREFIX}: the e2e pass reports ZERO covered statements in ` +
        `${subject}. It contributed nothing, so the "merged" number is the unit ` +
        `number wearing a merged label. The e2e suite did not reach this file.`,
    );
  }
}

function nearMiss(files, subject) {
  const hits = nearMisses(files ?? [], subject);
  if (hits.length === 0) return "";
  const shown = hits.slice(0, 5).map((f) => `\n    - ${f}`).join("");
  return (
    `\n  The e2e map does have same-named file(s) under a different path — a ` +
    `path-spelling mismatch splits one file into two one-sided entries:${shown}` +
    (hits.length > 5 ? `\n    …and ${hits.length - 5} more` : "")
  );
}

/**
 * One-sided files are NORMAL away from the subject: the unit pass measures the
 * browser bundles the CLI's own bundle never imports, and vice versa. The
 * subject is checked by `assertMergeIsHonest`; this only reports the rest, so
 * the count on screen is never mistaken for the guard having been skipped.
 */
export function describeOneSidedFiles(unitFiles, e2eFiles) {
  const onlyUnit = unitFiles.filter((f) => !e2eFiles.includes(f));
  const onlyE2e = e2eFiles.filter((f) => !unitFiles.includes(f));
  return `${onlyUnit.length} file(s) measured by the unit pass only, ${onlyE2e.length} by the e2e pass only`;
}
