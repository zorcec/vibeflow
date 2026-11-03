// Local ESLint rules for the warn-only AI-first report
// (eslint.config.ai-warn.mjs). Kept here instead of a third-party plugin so
// `lint:ai` needs no extra test-framework-specific dependency.
// No-op stubs for disable-comments that reference lint plugins installed in
// other toolchains (private repo security/no-secrets, editor react-hooks
// suggestions). The public repo never installed them, so without stubs the
// disable comments fail the report with "Definition for rule ... not
// found". Registered here and forced "off" in the test-hygiene blocks.
const noopRule = { create: () => ({}) };
export const legacyStubs = {
  "react-hooks": { rules: { "exhaustive-deps": noopRule } },
  security: { rules: { "detect-unsafe-regex": noopRule } },
  "no-secrets": { rules: { "no-secrets": noopRule } },
};

export default {
  rules: {
    // Warns on skipped tests (it.skip/describe.skip/xit/...) which hide
    // coverage. Focused tests (.only) stay an ERROR via core
    // no-restricted-syntax in the main config — the two severities cannot
    // share one rule key, hence this separate rule.
    "no-skipped-tests": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Prefer fixing or deleting tests over .skip — skips hide coverage.",
        },
      },
      create(context) {
        const report = (node) =>
          context.report({
            node,
            message:
              "Skipped tests hide coverage — prefer fixing or deleting over .skip.",
          });
        return {
          "CallExpression[callee.property.name='skip']": report,
          "CallExpression[callee.name=/^(xdescribe|xit|xtest)$/]": report,
        };
      },
    },
  },
};
