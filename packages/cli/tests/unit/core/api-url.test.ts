import { describe, it, expect, afterEach } from "vitest";
import { DEFAULT_API_URL, getApiUrl } from "../../../src/core/api-url.js";

afterEach(() => {
  delete process.env.VIBEFLOW_API_URL;
});

describe("core/api-url", () => {
  it("defaults to the production host", () => {
    delete process.env.VIBEFLOW_API_URL;
    expect(DEFAULT_API_URL).toBe("https://freemium.vibeflow.tools");
    expect(getApiUrl()).toBe("https://freemium.vibeflow.tools");
  });

  it("honours the VIBEFLOW_API_URL override (local dev, stage, tests)", () => {
    process.env.VIBEFLOW_API_URL = "http://localhost:3000";
    expect(getApiUrl()).toBe("http://localhost:3000");
  });

  it("trims trailing slashes from the override", () => {
    process.env.VIBEFLOW_API_URL = "http://custom-api:9000///";
    expect(getApiUrl()).toBe("http://custom-api:9000");
  });

  it("falls back to production for non-http(s) values so tokens never leak", () => {
    process.env.VIBEFLOW_API_URL = "file:///etc/passwd";
    expect(getApiUrl()).toBe(DEFAULT_API_URL);
  });

  it("falls back to production for malformed values", () => {
    process.env.VIBEFLOW_API_URL = "not a url";
    expect(getApiUrl()).toBe(DEFAULT_API_URL);
  });
});
