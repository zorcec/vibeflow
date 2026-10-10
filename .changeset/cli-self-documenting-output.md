---
"@vibeflow-tools/cli": patch
---

Make verify and task output self-documenting for agents without loaded skills

Guidance that lives only in skills reaches only agents that load them: a
run printed its evidence-explorer sub-commands and the agent still
hand-parsed the evidence JSON, and another agent assumed
`tasks --get --json` does not exist when it does. The tools now teach their
own correct use, in imperative form, where the agent's eyes already are.

- `vibeflow verify` post-run output: the explorer block is now an explicit
  instruction ("Before reading evidence files by hand, explore them with:")
  directly after the evidence file list, with the STATIC-capture caveat
  (hover/focus/behavior still needs a live headless-Playwright check).
- `tasks --get` agent-instructions boilerplate: the Details line notes
  `--json` for machine-readable output, and a new Evidence line sends agents
  to the explorer sub-commands instead of hand-parsing evidence JSON.
- `vibeflow verify --help`: the command description names the explorer
  sub-commands and the STATIC-capture scope.
