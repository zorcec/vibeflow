/**
 * Tests must not depend on whether they run under pi (ticket b7dvqr7z).
 *
 * The agent identity is DERIVED from the ancestor process tree, so a suite
 * launched from a pi session would see `agent: pi-<pid>` where CI sees none —
 * the same assertion passing or failing depending on who runs it. This pins it
 * off globally; the derivation itself is tested through an injected tree.
 */
process.env.VIBEFLOW_AGENT_IDENTITY = "off";
