import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseModel } from "../../src/telegram/opencode-client.js";

describe("opencode-client", () => {
  describe("parseModel", () => {
    it("parses provider/model format", () => {
      const result = parseModel("opencode-go/mimo-v2.5");
      expect(result).toEqual({ providerID: "opencode-go", modelID: "mimo-v2.5" });
    });

    it("handles model IDs with slashes", () => {
      const result = parseModel("openai/gpt-4o/variant");
      expect(result).toEqual({ providerID: "openai", modelID: "gpt-4o/variant" });
    });

    it("handles single segment (no slash)", () => {
      const result = parseModel("single-model");
      expect(result).toEqual({ providerID: "single-model", modelID: "" });
    });
  });
});
