/**
 * Shared paste-to-attach helpers for the overlay task forms
 * (the floating popover and the React add-task modal).
 *
 * Mirrors the kanban DetailPanel create-mode semantics:
 * - image clipboard items → the shared ingest matrix
 *   (`transformImageForUpload`: <=1920 PNG/JPEG kept byte-identical with
 *   their true extension, wider shots resized to 1920 + WebP q80),
 *   buffered until the task is created, then uploaded as a task file;
 * - any other pasted file kinds (csv, pdf, …) → uploaded as-is;
 * - plain-text paste inside text inputs is never intercepted.
 *
 * The pure functions here (filename building, clipboard classification,
 * intercept decision, upload-URL building) are unit-tested without a
 * browser runtime; only the canvas-backed transform needs a browser.
 */

import {
  buildPasteFilename as buildMatrixPasteFilename,
  extensionForMime,
  transformImageForUpload,
} from "@vibeflow-tools/ui/kanban";

/** Timestamp shape shared with kanban: `paste-2026-10-07T12-34-56.<ext>`. */
export function buildPasteFilename(now: Date = new Date()): string {
  return buildMatrixPasteFilename(now, extensionForMime("image/png"));
}

/** File extension to use when compression is unavailable and the raw blob is kept. */
export function pasteExtensionForMime(mime: string): string {
  return extensionForMime(mime);
}

export interface PastedFiles {
  images: Blob[];
  others: File[];
}

type ClipboardItemsLike = Pick<DataTransfer, "items"> | null | undefined;

/** True when the clipboard carries at least one file-kind item. */
export function hasFileItems(
  clipboardData: ClipboardItemsLike,
): boolean {
  if (!clipboardData) return false;
  return Array.from(clipboardData.items).some((it) => it.kind === "file");
}

/**
 * Split clipboard items the kanban way: a pasted image wins and any other
 * file kinds are ignored for that paste; otherwise every non-image file
 * item is kept as-is. Plain-text items never appear in the result.
 */
export function collectPastedFiles(
  clipboardData: ClipboardItemsLike,
): PastedFiles {
  const out: PastedFiles = { images: [], others: [] };
  if (!clipboardData) return out;
  const items = Array.from(clipboardData.items);
  const imageItem = items.find((it) => it.type.startsWith("image/"));
  if (imageItem) {
    const blob = imageItem.getAsFile();
    if (blob) out.images.push(blob);
    return out;
  }
  for (const item of items) {
    if (item.kind === "file" && !item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) out.others.push(file);
    }
  }
  return out;
}

/**
 * Decide whether a paste event should be intercepted for file attach.
 * Plain-text paste inside text inputs is left alone; image/file clipboard
 * content is intercepted even in text fields (they cannot accept files),
 * and paste outside text inputs is always intercepted (matching kanban).
 */
export function shouldInterceptPaste(
  target: EventTarget | null,
  hasFiles: boolean,
): boolean {
  if (hasFiles) return true;
  const tag = (target as HTMLElement | null)?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return false;
  if (
    typeof (target as HTMLElement | null)?.isContentEditable === "boolean" &&
    (target as HTMLElement).isContentEditable
  )
    return false;
  return true;
}

/**
 * Turn a pasted image blob into an attachable File via the shared ingest
 * matrix. The transform never throws or drops bytes: without a canvas
 * pipeline the raw blob is kept with a matching true extension.
 */
export async function pastedImageToFile(
  blob: Blob,
  now: Date = new Date(),
): Promise<File> {
  const { file } = await transformImageForUpload(blob, `clipboard.png`);
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ext = file.name.split(".").pop() ?? extensionForMime(blob.type);
  return new File([file], `paste-${ts}.${ext}`, { type: file.type });
}

/**
 * Blob URL for a chip thumbnail, or null when the runtime cannot mint one.
 * Never throws — old browsers and jsdom simply render the 📎 fallback.
 */
export function safePreviewUrl(file: File): string | null {
  try {
    if (
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    )
      return null;
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

/** Revoke a thumbnail URL minted by {@link safePreviewUrl}; never throws. */
export function revokePreviewUrl(url: string | null): void {
  if (!url) return;
  try {
    URL.revokeObjectURL?.(url);
  } catch {
    /* ignore */
  }
}

/** Upload URL for a task file — same shape the kanban client uses. */
export function taskFileUploadUrl(
  apiUrl: string,
  taskId: string,
  filename: string,
): string {
  return `${apiUrl}/${taskId}/files/${encodeURIComponent(filename)}`;
}

/**
 * Raw-octet-stream file upload, byte-for-byte the kanban `api.uploadFile`
 * contract (`POST /api/tasks/:id/files/:name`, no multipart envelope).
 */
export async function uploadTaskFile(
  apiUrl: string,
  taskId: string,
  file: File,
): Promise<void> {
  const buf = await file.arrayBuffer();
  await fetch(taskFileUploadUrl(apiUrl, taskId, file.name), {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: buf,
  });
}
