/**
 * Shared paste-to-attach helpers for the overlay task forms
 * (the floating popover and the React add-task modal).
 *
 * Mirrors the kanban DetailPanel create-mode semantics:
 * - image clipboard items → compressed JPEG named `paste-<timestamp>.jpg`,
 *   buffered until the task is created, then uploaded as a task file;
 * - any other pasted file kinds (csv, pdf, …) → uploaded as-is;
 * - plain-text paste inside text inputs is never intercepted.
 *
 * The pure functions here (filename building, clipboard classification,
 * intercept decision, upload-URL building) are unit-tested without a
 * browser runtime; only `compressImageToJpeg` needs canvas.
 */

/** Lowest timestamp shape shared with kanban: `paste-2026-10-07T12-34-56.jpg`. */
export function buildPasteFilename(now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `paste-${ts}.jpg`;
}

/** File extension to use when compression is unavailable and the raw blob is kept. */
export function pasteExtensionForMime(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  const sub = /^image\/([a-z0-9]+)/i.exec(mime)?.[1]?.toLowerCase();
  if (sub) return sub === "jpeg" ? "jpg" : sub;
  return "bin";
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

/** Downscale-free JPEG compression identical to the kanban DetailPanel. */
export function compressImageToJpeg(
  source: Blob,
  quality = 0.8,
): Promise<Blob> {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("image compression unavailable"));
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(source);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        revokePreviewUrl(url);
        reject(new Error("canvas unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      revokePreviewUrl(url);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("canvas.toBlob failed"));
        },
        "image/jpeg",
        quality,
      );
    };
    img.onerror = () => {
      revokePreviewUrl(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

/**
 * Turn a pasted image blob into an attachable File. Compression is
 * attempted first; when canvas/image loading is unavailable the raw blob
 * is kept with a matching extension so paste never silently drops.
 */
export async function pastedImageToFile(
  blob: Blob,
  now: Date = new Date(),
): Promise<File> {
  try {
    const compressed = await compressImageToJpeg(blob);
    return new File([compressed], buildPasteFilename(now), {
      type: "image/jpeg",
    });
  } catch {
    const ext = pasteExtensionForMime(blob.type);
    const base = buildPasteFilename(now).replace(/\.jpg$/, "");
    return new File([blob], `${base}.${ext}`, {
      type: blob.type || "application/octet-stream",
    });
  }
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
