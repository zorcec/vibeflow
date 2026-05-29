import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerVariant,
  getRegisteredVariant,
  clearVariantRegistry,
} from "../src/registry.js";

describe("registry", () => {
  beforeEach(() => {
    clearVariantRegistry();
  });

  afterEach(() => {
    clearVariantRegistry();
  });

  describe("registerVariant", () => {
    it("registers a variant definition", () => {
      registerVariant("TaskCard", {
        default: {},
        minimal: { compact: true },
      });
      const result = getRegisteredVariant("TaskCard");
      expect(result).toEqual({
        default: {},
        minimal: { compact: true },
      });
    });

    it("overwrites a previously registered variant", () => {
      registerVariant("TaskCard", { default: {} });
      registerVariant("TaskCard", { default: {}, v2: { x: 1 } });
      expect(getRegisteredVariant("TaskCard")).toEqual({ default: {}, v2: { x: 1 } });
    });

    it("allows registering multiple scopes independently", () => {
      registerVariant("A", { default: {} });
      registerVariant("B", { default: {}, alt: {} });
      expect(getRegisteredVariant("A")).toEqual({ default: {} });
      expect(getRegisteredVariant("B")).toEqual({ default: {}, alt: {} });
    });
  });

  describe("getRegisteredVariant", () => {
    it("returns undefined for unregistered scope", () => {
      expect(getRegisteredVariant("Unknown")).toBeUndefined();
    });
  });

  describe("clearVariantRegistry", () => {
    it("removes all registered variants", () => {
      registerVariant("A", { default: {} });
      registerVariant("B", { default: {} });
      clearVariantRegistry();
      expect(getRegisteredVariant("A")).toBeUndefined();
      expect(getRegisteredVariant("B")).toBeUndefined();
    });
  });
});
