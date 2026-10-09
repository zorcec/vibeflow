/**
 * Unit tests for the overlay paste-to-attach helpers
 * (src/client/overlay-browser/paste.ts).
 *
 * Everything here is DOM-free by design: clipboard payloads are plain fakes,
 * so these tests prove the classification / naming / intercept contract
 * without a browser runtime. Image ingest itself follows the shared matrix
 * (PNG/JPEG kept with true extensions here — no canvas in unit tests).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildPasteFilename,
  collectPastedFiles,
  hasFileItems,
  pastedImageToFile,
  pasteExtensionForMime,
  shouldInterceptPaste,
  taskFileUploadUrl,
  uploadTaskFile,
} from "../../src/client/overlay-browser/paste.js";

function fileItem(
  file: File | null,
  type: string,
  kind: string = "file",
): DataTransferItem {
  return { kind, type, getAsFile: () => file } as unknown as DataTransferItem;
}

function stringItem(type: string = "text/plain"): DataTransferItem {
  return {
    kind: "string",
    type,
    getAsFile: () => null,
  } as unknown as DataTransferItem;
}

const PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84,
  120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 160, 90, 186, 57, 0, 0, 0, 0,
  73, 69, 78, 68, 174, 66, 96, 130,
]);
const pngFile = (name = "clipboard.png") =>
  new File([PNG_BYTES], name, { type: "image/png" });

describe("buildPasteFilename", () => {
  it("matches the kanban paste-<iso-ts>.png shape", () => {
    expect(buildPasteFilename(new Date("2026-10-07T12:34:56.789Z"))).toBe(
      "paste-2026-10-07T12-34-56.png",
    );
  });

  it("is unique per millisecond-adjacent second", () => {
    const a = buildPasteFilename(new Date("2026-10-07T12:34:56.000Z"));
    const b = buildPasteFilename(new Date("2026-10-07T12:34:57.000Z"));
    expect(a).not.toBe(b);
  });
});

describe("pasteExtensionForMime", () => {
  it("maps jpeg to jpg and keeps other image subtypes", () => {
    expect(pasteExtensionForMime("image/jpeg")).toBe("jpg");
    expect(pasteExtensionForMime("image/png")).toBe("png");
    expect(pasteExtensionForMime("image/svg+xml")).toBe("svg");
  });

  it("falls back to bin for non-image types", () => {
    expect(pasteExtensionForMime("text/csv")).toBe("bin");
    expect(pasteExtensionForMime("")).toBe("bin");
  });
});

describe("hasFileItems", () => {
  it("detects file-kind items and ignores text", () => {
    expect(hasFileItems({ items: [stringItem()] })).toBe(false);
    expect(hasFileItems({ items: [fileItem(pngFile(), "image/png")] })).toBe(
      true,
    );
  });

  it("is false for null clipboard data", () => {
    expect(hasFileItems(null)).toBe(false);
    expect(hasFileItems(undefined)).toBe(false);
  });
});

describe("collectPastedFiles", () => {
  it("returns the pasted image and ignores co-pasted files (kanban parity)", () => {
    const csv = new File(["a,b"], "data.csv", { type: "text/csv" });
    const out = collectPastedFiles({
      items: [
        stringItem(),
        fileItem(pngFile(), "image/png"),
        fileItem(csv, "text/csv"),
      ],
    });
    expect(out.images).toHaveLength(1);
    expect(out.others).toHaveLength(0);
  });

  it("passes non-image files through as-is", () => {
    const csv = new File(["a,b"], "data.csv", { type: "text/csv" });
    const pdf = new File(["%PDF"], "doc.pdf", { type: "application/pdf" });
    const out = collectPastedFiles({
      items: [
        stringItem(),
        fileItem(csv, "text/csv"),
        fileItem(pdf, "application/pdf"),
      ],
    });
    expect(out.images).toHaveLength(0);
    expect(out.others.map((f) => f.name)).toEqual(["data.csv", "doc.pdf"]);
  });

  it("returns empty for text-only or missing clipboard data", () => {
    expect(collectPastedFiles({ items: [stringItem()] })).toEqual({
      images: [],
      others: [],
    });
    expect(collectPastedFiles(null)).toEqual({ images: [], others: [] });
  });

  it("skips image items whose blob is unavailable", () => {
    const out = collectPastedFiles({
      items: [fileItem(null, "image/png")],
    });
    expect(out).toEqual({ images: [], others: [] });
  });
});

describe("shouldInterceptPaste", () => {
  const textarea = { tagName: "TEXTAREA", isContentEditable: false };
  const input = { tagName: "INPUT", isContentEditable: false };
  const editable = { tagName: "DIV", isContentEditable: true };
  const plainDiv = { tagName: "DIV", isContentEditable: false };

  it("never intercepts plain-text paste inside text inputs", () => {
    expect(shouldInterceptPaste(textarea as unknown as EventTarget, false)).toBe(
      false,
    );
    expect(shouldInterceptPaste(input as unknown as EventTarget, false)).toBe(
      false,
    );
    expect(shouldInterceptPaste(editable as unknown as EventTarget, false)).toBe(
      false,
    );
  });

  it("still intercepts image/file paste inside text fields", () => {
    expect(shouldInterceptPaste(textarea as unknown as EventTarget, true)).toBe(
      true,
    );
    expect(shouldInterceptPaste(input as unknown as EventTarget, true)).toBe(
      true,
    );
  });

  it("intercepts paste outside text inputs (kanban document-level parity)", () => {
    expect(shouldInterceptPaste(plainDiv as unknown as EventTarget, false)).toBe(
      true,
    );
    expect(shouldInterceptPaste(null, false)).toBe(true);
  });
});

describe("pastedImageToFile", () => {
  it("keeps the raw blob with its true extension without a browser pipeline", async () => {
    const file = await pastedImageToFile(
      pngFile(),
      new Date("2026-10-07T12:34:56.000Z"),
    );
    expect(file.name).toBe("paste-2026-10-07T12-34-56.png");
    expect(file.type).toBe("image/png");
    expect(await file.arrayBuffer()).toEqual(PNG_BYTES.buffer);
  });
});

describe("taskFileUploadUrl", () => {
  it("encodes the filename into the kanban-shaped files URL", () => {
    expect(
      taskFileUploadUrl(
        "http://localhost:3933/api/tasks",
        "task-1",
        "paste-2026-10-07T12-34-56.jpg",
      ),
    ).toBe(
      "http://localhost:3933/api/tasks/task-1/files/paste-2026-10-07T12-34-56.jpg",
    );
    expect(taskFileUploadUrl("http://h/api/tasks", "t", "a b.png")).toBe(
      "http://h/api/tasks/t/files/a%20b.png",
    );
  });
});

describe("uploadTaskFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the raw bytes as octet-stream (kanban contract, no multipart)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true } as Response;
      }),
    );
    const file = pngFile("paste-x.png");
    await uploadTaskFile("http://localhost:3933/api/tasks", "task-1", file);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://localhost:3933/api/tasks/task-1/files/paste-x.png",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({
      "Content-Type": "application/octet-stream",
    });
    expect(new Uint8Array(calls[0].init.body as ArrayBuffer)).toEqual(
      PNG_BYTES,
    );
  });
});
