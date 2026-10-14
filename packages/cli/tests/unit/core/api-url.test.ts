import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_API_URL,
  getApiUrl,
  surfacePath,
} from "../../../src/core/api-url.js";

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

describe("core/api-url surfacePath", () => {
  it("local target keeps the legacy path byte-for-byte", () => {
    expect(surfacePath("local", "/api/tasks/abc/baseline")).toBe(
      "/api/tasks/abc/baseline",
    );
    expect(surfacePath("local", "/api/cli/settings")).toBe(
      "/api/cli/settings",
    );
    expect(surfacePath("local", "/api/cli/import")).toBe("/api/cli/import");
  });

  it("cloud target maps task-subresource paths to the v1 equivalents", () => {
    expect(surfacePath("cloud", "/api/tasks/abc/baseline")).toBe(
      "/api/v1/tasks/abc/baseline",
    );
    expect(surfacePath("cloud", "/api/tasks/abc/baseline-page")).toBe(
      "/api/v1/tasks/abc/baseline-page",
    );
    expect(surfacePath("cloud", "/api/tasks/abc/auth-state")).toBe(
      "/api/v1/tasks/abc/auth-state",
    );
    expect(surfacePath("cloud", "/api/tasks/abc/files")).toBe(
      "/api/v1/tasks/abc/files",
    );
  });

  it("cloud target maps the cli surface to the v1 equivalents", () => {
    expect(surfacePath("cloud", "/api/cli/settings")).toBe(
      "/api/v1/settings",
    );
    expect(surfacePath("cloud", "/api/cli/workspaces")).toBe(
      "/api/v1/boards",
    );
    expect(surfacePath("cloud", "/api/cli/profile")).toBe("/api/v1/me");
    expect(surfacePath("cloud", "/api/cli/tasks")).toBe("/api/v1/tasks");
    expect(surfacePath("cloud", "/api/cli/tasks/abc/comments")).toBe(
      "/api/v1/tasks/abc/comments",
    );
  });

  it("cloud target preserves a trailing query string verbatim", () => {
    expect(surfacePath("cloud", "/api/cli/tasks?boardId=ws-1")).toBe(
      "/api/v1/tasks?boardId=ws-1",
    );
  });

  it("cloud target leaves unmapped paths unchanged", () => {
    expect(surfacePath("cloud", "/api/cli/auth/device-init")).toBe(
      "/api/cli/auth/device-init",
    );
    expect(surfacePath("cloud", "/api/cli/auth/device-poll")).toBe(
      "/api/cli/auth/device-poll",
    );
  });

  it("cloud target throws for /api/cli/import (no batch op — loop POST /api/v1/tasks)", () => {
    expect(() => surfacePath("cloud", "/api/cli/import")).toThrow(/no \/api\/v1 equivalent/);
  });
});
