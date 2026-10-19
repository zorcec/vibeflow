/**
 * Feature-flag parsing (ticket 0847833f follow-up): one env var,
 * `VIBEFLOW_FEATURES`, holds a comma- and/or space-separated list.
 * Case-insensitive matching so shell copypaste casing never silently
 * disables a feature.
 */
import { describe, it, expect } from "vitest";
import {
  parseFeatureFlags,
  isFeatureEnabled,
  FEATURE_FLAGS_ENV_VAR,
} from "../../../src/core/feature-flags.js";

describe("parseFeatureFlags", () => {
  it("returns [] for unset, empty, and blank values", () => {
    expect(parseFeatureFlags(undefined, {})).toEqual([]);
    expect(parseFeatureFlags("", {})).toEqual([]);
    expect(parseFeatureFlags("  ,  ", {})).toEqual([]);
  });

  it("splits on commas and whitespace, uppercases, drops empties", () => {
    expect(parseFeatureFlags("CHAT", {})).toEqual(["CHAT"]);
    expect(parseFeatureFlags("chat", {})).toEqual(["CHAT"]);
    expect(parseFeatureFlags("CHAT,FOO BAR", {})).toEqual(["CHAT", "FOO", "BAR"]);
    expect(parseFeatureFlags("  CHAT ,,  FOO  ", {})).toEqual(["CHAT", "FOO"]);
  });

  it("reads the env var when no explicit value is given", () => {
    expect(parseFeatureFlags(undefined, { [FEATURE_FLAGS_ENV_VAR]: "chat" })).toEqual([
      "CHAT",
    ]);
    expect(parseFeatureFlags("OTHER", { [FEATURE_FLAGS_ENV_VAR]: "CHAT" })).toEqual([
      "OTHER",
    ]);
  });
});

describe("isFeatureEnabled", () => {
  it("matches case-insensitively", () => {
    expect(isFeatureEnabled("CHAT", { VIBEFLOW_FEATURES: "chat" })).toBe(true);
    expect(isFeatureEnabled("chat", { VIBEFLOW_FEATURES: "CHAT" })).toBe(true);
    expect(isFeatureEnabled("Chat", {})).toBe(false);
  });

  it("finds flags inside multi-flag lists", () => {
    expect(isFeatureEnabled("CHAT", { VIBEFLOW_FEATURES: "CHAT,FOO" })).toBe(true);
    expect(isFeatureEnabled("FOO", { VIBEFLOW_FEATURES: "CHAT FOO" })).toBe(true);
    expect(isFeatureEnabled("BAR", { VIBEFLOW_FEATURES: "CHAT,FOO" })).toBe(false);
  });

  it("is off by default (unset or empty)", () => {
    expect(isFeatureEnabled("CHAT", {})).toBe(false);
    expect(isFeatureEnabled("CHAT", { VIBEFLOW_FEATURES: "" })).toBe(false);
  });
});
