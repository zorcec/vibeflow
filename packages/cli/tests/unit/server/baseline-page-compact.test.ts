/**
 * Baseline-page storage contract (ticket 66c16b50, from 1caca8cc):
 * POST /api/tasks/:id/baseline-page stores compact JSON with ONE style map
 * per element. The capture fills `baseline` and `after` with the same values,
 * so the duplicate map is stripped server-side and the file is written without
 * indentation — every existing reader (verify step 14, verify-tools
 * readEvidence back-fill, page-diff) reads `.after` and back-fills `.baseline`
 * from it, so nothing is lost.
 *
 * Boots the real API-only server in offline mode (same harness as
 * system-file-flag.test.ts), so the assertions cover the actual handler.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTask } from "../../../src/core/tasks.js";
import { writeConfig } from "../../../src/core/config.js";
import { getFilesDir } from "../../../src/core/files.js";
import {
  readEvidence,
  queryStyle,
} from "../../../src/commands/verify-tools.js";
import { serveWithPort } from "../../helpers/serve-with-port.js";
import type { ServeInstance } from "../../../src/server/server.js";

process.env.VIBEFLOW_TELEMETRY = "0";

describe("baseline-page storage contract", () => {
  let tempDir: string;
  let instance: ServeInstance;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-pagecompact-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      // @internal test hooks — force OFFLINE mode so local task routes mount
      _testToken: null,
      _testWorkspace: null,
    });
  });

  afterEach(async () => {
    await instance.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function fullElement(styles: Record<string, string>) {
    return {
      key: "0/1",
      selector: "div.card",
      tag: "div",
      classes: ["card"],
      dataAttrs: {},
      parentKey: "0",
      childCount: 0,
      childSignature: [],
      text: "hello",
      position: { x: 1, y: 2, width: 3, height: 4 },
      baseline: { ...styles },
      after: { ...styles },
    };
  }

  it("stores one style map per element as compact JSON", async () => {
    const task = createTask(tempDir, {
      title: "Page compact test",
      description: "",
      status: "todo",
      selector: "/",
    });
    const styles = { color: "red", display: "block" };
    const res = await fetch(
      `${instance.url}/api/tasks/${task.id}/baseline-page`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page: {
            version: 1,
            elements: { "0/1": fullElement(styles) },
            capturedAt: new Date().toISOString(),
            truncated: false,
          },
        }),
      },
    );
    expect(res.status).toBe(200);

    const raw = readFileSync(
      join(getFilesDir(tempDir, task.id), "baseline-page.json"),
      "utf-8",
    );
    // Compact: no pretty-print indentation.
    expect(raw).not.toContain("\n  ");
    expect(raw).toBe(JSON.stringify(JSON.parse(raw)));

    const stored = JSON.parse(raw) as {
      version: number;
      truncated: boolean;
      capturedAt: string;
      elements: Record<string, Record<string, unknown>>;
    };
    // Envelope untouched.
    expect(stored.version).toBe(1);
    expect(stored.truncated).toBe(false);
    expect(typeof stored.capturedAt).toBe("string");
    // The duplicate map is gone; every other field is unchanged.
    const el = stored.elements["0/1"];
    expect(el).not.toHaveProperty("baseline");
    expect(el.after).toEqual(styles);
    expect(el.selector).toBe("div.card");
    expect(el.tag).toBe("div");
    expect(el.classes).toEqual(["card"]);
    expect(el.dataAttrs).toEqual({});
    expect(el.parentKey).toBe("0");
    expect(el.key).toBe("0/1");
    expect(el.childCount).toBe(0);
    expect(el.childSignature).toEqual([]);
    expect(el.text).toBe("hello");
    expect(el.position).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("style_query on the stored after-only file reports no change for unchanged elements", async () => {
    // The exact thing a diff-instead-of-maps would have broken: page-wide
    // query tools need materialised full style maps for elements that did
    // NOT change. The back-fill restores them from `.after` at read time.
    const here = dirname(fileURLToPath(import.meta.url));
    const page = JSON.parse(
      gunzipSync(
        readFileSync(
          join(here, "..", "..", "fixtures", "baseline-page-883871d0.json.gz"),
        ),
      ).toString("utf-8"),
    ) as { elements: Record<string, Record<string, unknown>> };
    const stored = JSON.parse(JSON.stringify(page)) as typeof page;
    for (const el of Object.values(stored.elements)) {
      delete el.baseline;
    }
    const filesDir = getFilesDir(tempDir, "sq-task");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "baseline-page.json"), JSON.stringify(stored));
    writeFileSync(
      join(filesDir, "verify-all-styles.json"),
      JSON.stringify(page),
    );
    const ev = await readEvidence(tempDir, "sq-task");
    const res = queryStyle(ev, "color") as { ok: boolean; matches: unknown[] };
    expect(res.ok).toBe(true);
    // Stored baseline and after capture hold the same values: nothing changed.
    expect(res.matches).toEqual([]);
  });

  it("accepts elements that already carry no baseline map", async () => {
    const task = createTask(tempDir, {
      title: "Page compact idempotent test",
      description: "",
      status: "todo",
      selector: "/",
    });
    const { baseline: _dropped, ...afterOnly } = fullElement({ color: "red" });
    const res = await fetch(
      `${instance.url}/api/tasks/${task.id}/baseline-page`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page: {
            version: 1,
            elements: { "0/1": afterOnly },
            capturedAt: new Date().toISOString(),
            truncated: false,
          },
        }),
      },
    );
    expect(res.status).toBe(200);
    const stored = JSON.parse(
      readFileSync(
        join(getFilesDir(tempDir, task.id), "baseline-page.json"),
        "utf-8",
      ),
    ) as { elements: Record<string, Record<string, unknown>> };
    expect(stored.elements["0/1"]).not.toHaveProperty("baseline");
    expect(stored.elements["0/1"].after).toEqual({ color: "red" });
  });
});
