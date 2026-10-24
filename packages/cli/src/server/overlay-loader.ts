/**
 * Console/bookmarklet bootstrap. Agent choice for q2k7caym: try the ordinary
 * script first, then fetch + blob (no eval). This helps permissive blob policies,
 * not nonce-only policies; connect-src and CORS must still allow the fetch.
 * Keep this function self-contained: its source executes on a foreign page.
 */
function loadOverlay(scriptUrl: string, boardId: string | undefined): void {
  const rootId = "vibeflow-studio-root";
  if (document.getElementById(rootId) || document.getElementById("proto-studio-root")) return;
  let finished = false;
  let blobUrl: string | undefined;
  const message = "Vibeflow overlay could not initialise. The page's Content-Security-Policy (CSP) may block it. Allow the overlay origin in script-src and connect-src, or permit blob: in script-src plus the overlay origin in connect-src. For nonce-only/strict-dynamic policies, use the browser extension or ask the site owner to adjust CSP. Network or CORS restrictions can also prevent loading.";
  function cleanup(): void {
    clearTimeout(timeout);
    clearInterval(poll);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
  function fail(): void {
    if (finished) return;
    finished = true;
    cleanup();
    console.error(message);
    const notice = document.createElement("div");
    notice.id = "vibeflow-overlay-load-error";
    notice.setAttribute("role", "alert");
    notice.textContent = message;
    (document.body || document.documentElement).appendChild(notice);
  }
  /* Ten seconds bounds stalled fetches and scripts that never create the
     overlay host. Polling covers DOMContentLoaded-delayed startup. */
  const timeout = setTimeout(fail, 10_000);
  const poll = setInterval(() => {
    if (document.getElementById(rootId)) {
      finished = true;
      cleanup();
    }
  }, 50);
  document.getElementById("vibeflow-overlay-load-error")?.remove();
  function script(src: string): HTMLScriptElement {
    const element = document.createElement("script");
    element.src = src;
    element.setAttribute("data-vibeflow-overlay", "");
    /* Blob URLs have no server origin. Keep the original source so local
       API/WS resolution matches the direct script. */
    element.setAttribute("data-vibeflow-source", scriptUrl);
    if (boardId) element.setAttribute("data-board-id", boardId);
    return element;
  }
  const direct = script(scriptUrl);
  direct.onerror = () => {
    direct.remove();
    void fetch(scriptUrl).then(response => {
      if (!response.ok) throw new Error("Overlay HTTP " + response.status);
      return response.text();
    }).then(code => {
      if (finished) return;
      blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const fallback = script(blobUrl);
      fallback.onerror = fail;
      document.head.appendChild(fallback);
    }).catch(fail);
  };
  document.head.appendChild(direct);
}

/** Same bootstrap for local/remote guides and console/bookmarklet entry points. */
export function buildOverlayLoader(scriptUrl: string, boardId?: string): string {
  return `(${loadOverlay.toString().replace(/\n/g, " ")})(${JSON.stringify(scriptUrl)},${JSON.stringify(boardId) ?? "undefined"});`;
}
