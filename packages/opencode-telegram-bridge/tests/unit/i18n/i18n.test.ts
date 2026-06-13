import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  mapToSupported,
  t,
  toolName,
  SUPPORTED_LOCALES,
  LANGUAGE_NAMES,
} from "../../../src/i18n/index.js";

describe("i18n", () => {
  // ── detectLanguage ────────────────────────────────────────────────────────

  describe("detectLanguage", () => {
    it("detects English text", () => {
      expect(detectLanguage("Hello, how are you?")).toBe("en");
    });

    it("detects German text", () => {
      expect(detectLanguage("Wie geht es dir heute?")).toBe("de");
    });

    it("detects Croatian text", () => {
      expect(detectLanguage("Kako si danas?")).toBe("hr");
    });

    it("detects Bosnian and maps to Croatian", () => {
      expect(detectLanguage("Kako si danas?")).toBe("hr");
    });

    it("returns 'en' for empty text", () => {
      expect(detectLanguage("")).toBe("en");
      expect(detectLanguage("   ")).toBe("en");
    });

    it("returns 'en' for very short text (low confidence)", () => {
      expect(detectLanguage("ok")).toBe("en");
    });

    it("detects German formal text", () => {
      expect(detectLanguage("Ich möchte bitte einen Termin vereinbaren.")).toBe("de");
    });

    it("detects Croatian formal text", () => {
      expect(detectLanguage("Molim vas da mi pomognete s ovim zadatkom.")).toBe("hr");
    });
  });

  // ── mapToSupported ────────────────────────────────────────────────────────

  describe("mapToSupported", () => {
    it("maps 'en' to 'en'", () => {
      expect(mapToSupported("en")).toBe("en");
    });

    it("maps 'de' to 'de'", () => {
      expect(mapToSupported("de")).toBe("de");
    });

    it("maps 'hr' to 'hr'", () => {
      expect(mapToSupported("hr")).toBe("hr");
    });

    it("maps Bosnian 'bs' to 'hr'", () => {
      expect(mapToSupported("bs")).toBe("hr");
    });

    it("maps Serbian 'sr' to 'hr'", () => {
      expect(mapToSupported("sr")).toBe("hr");
    });

    it("maps Slovenian 'sl' to 'hr'", () => {
      expect(mapToSupported("sl")).toBe("hr");
    });

    it("maps ISO-639-3 codes", () => {
      expect(mapToSupported("deu")).toBe("de");
      expect(mapToSupported("eng")).toBe("en");
    });

    it("returns 'en' for null/undefined", () => {
      expect(mapToSupported(null)).toBe("en");
      expect(mapToSupported(undefined)).toBe("en");
      expect(mapToSupported("")).toBe("en");
    });

    it("returns 'en' for unknown language", () => {
      expect(mapToSupported("xx")).toBe("en");
    });
  });

  // ── t() translation function ──────────────────────────────────────────────

  describe("t", () => {
    it("returns English string for 'en'", () => {
      expect(t("thinking", "en")).toBe("🤔 _Thinking..._");
    });

    it("returns German string for 'de'", () => {
      expect(t("thinking", "de")).toBe("🤔 _Nachdenken..._");
    });

    it("returns Croatian string for 'hr'", () => {
      expect(t("thinking", "hr")).toBe("🤔 _Razmišljam..._");
    });

    it("interpolates parameters", () => {
      const result = t("rate_limited", "en", { retryAfter: "30" });
      expect(result).toBe("Rate limited. Try again in 30s.");
    });

    it("interpolates parameters in German", () => {
      const result = t("model_changed", "de", { model: "gpt-4" });
      expect(result).toBe("✅ Modell geändert zu: gpt-4");
    });

    it("interpolates parameters in Croatian", () => {
      const result = t("queued", "hr", { count: "3" });
      expect(result).toBe("⏳ U redu čekanja (3 čeka)...");
    });

    it("falls back to English for unknown locale", () => {
      const result = t("thinking", "xx" as any);
      expect(result).toBe("🤔 _Thinking..._");
    });

    it("handles all keys exist in all locales", () => {
      for (const locale of SUPPORTED_LOCALES) {
        for (const key of ["thinking", "writing", "access_denied", "error_prefix", "start_help"]) {
          const result = t(key as any, locale);
          expect(result).toBeTruthy();
          expect(typeof result).toBe("string");
        }
      }
    });
  });

  // ── toolName ──────────────────────────────────────────────────────────────

  describe("toolName", () => {
    it("returns English name for known tool", () => {
      expect(toolName("bash", "en")).toBe("terminal");
    });

    it("returns German name for known tool", () => {
      expect(toolName("bash", "de")).toBe("Terminal");
    });

    it("returns Croatian name for known tool", () => {
      expect(toolName("bash", "hr")).toBe("terminal");
    });

    it("returns raw toolId for unknown tool", () => {
      expect(toolName("unknown-tool", "en")).toBe("unknown-tool");
    });

    it("handles all known tool IDs", () => {
      const tools = [
        "household-execute-query", "household-manage", "household-upload-receipt",
        "household-weather", "household-traffic", "household-tts", "household-stt",
        "webfetch", "bash", "read", "write", "edit", "glob", "grep", "skill",
      ];
      for (const tool of tools) {
        for (const locale of SUPPORTED_LOCALES) {
          const name = toolName(tool, locale);
          expect(name).toBeTruthy();
          expect(typeof name).toBe("string");
        }
      }
    });
  });

  // ── Constants ─────────────────────────────────────────────────────────────

  describe("constants", () => {
    it("SUPPORTED_LOCALES contains en, de, hr", () => {
      expect(SUPPORTED_LOCALES).toEqual(["en", "de", "hr"]);
    });

    it("LANGUAGE_NAMES maps all supported locales", () => {
      for (const locale of SUPPORTED_LOCALES) {
        expect(LANGUAGE_NAMES[locale]).toBeTruthy();
      }
    });

    it("LANGUAGE_NAMES has correct values", () => {
      expect(LANGUAGE_NAMES.en).toBe("English");
      expect(LANGUAGE_NAMES.de).toBe("German");
      expect(LANGUAGE_NAMES.hr).toBe("Croatian");
    });
  });
});
