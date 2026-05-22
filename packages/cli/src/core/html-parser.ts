import * as cheerio from "cheerio";
import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

export function extractProtoIds(html: string): string[] {
  const $ = cheerio.load(html);
  const ids: string[] = [];
  $("[data-vibeflow-id]").each((_, el) => {
    const id = $(el).attr("data-vibeflow-id");
    if (id) ids.push(id);
  });
  return ids;
}

export function injectScript(html: string, scriptContent: string): string {
  const scriptTag = `<script data-vibeflow-overlay>${scriptContent}</script>`;
  const bodyCloseIdx = html.lastIndexOf("</body>");
  if (bodyCloseIdx !== -1) {
    return (
      html.slice(0, bodyCloseIdx) + scriptTag + "\n" + html.slice(bodyCloseIdx)
    );
  }
  return html + "\n" + scriptTag;
}

export function hasExternalDependencies(html: string): string[] {
  const $ = cheerio.load(html);
  const externals: string[] = [];

  $('script[src]').each((_, el) => {
    const src = $(el).attr("src") ?? "";
    if (src.startsWith("http://") || src.startsWith("https://")) {
      externals.push(`script: ${src}`);
    }
  });

  $('link[rel="stylesheet"][href]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (href.startsWith("http://") || href.startsWith("https://")) {
      externals.push(`stylesheet: ${href}`);
    }
  });

  return externals;
}

export function isValidHtml(html: string): boolean {
  if (!html || html.trim().length === 0) return false;
  try {
    cheerio.load(html);
    return true;
  } catch {
    return false;
  }
}

export function getElementContent(
  html: string,
  protoId: string,
): string | null {
  const $ = cheerio.load(html);
  const el = $(`[data-vibeflow-id="${protoId}"]`);
  if (el.length === 0) return null;
  return $.html(el);
}

export function findHtmlFiles(dirPath: string): string[] {
  const stat = statSync(dirPath);
  if (!stat.isDirectory()) return [dirPath];

  return readdirSync(dirPath)
    .filter((f) => extname(f).toLowerCase() === ".html")
    .sort()
    .map((f) => join(dirPath, f));
}
