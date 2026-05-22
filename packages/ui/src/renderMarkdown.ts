function splitTableCells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded by literal | separators, not ReDoS-vulnerable
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function renderTables(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const headerLine = lines[i] ?? '';
    const dividerLine = lines[i + 1] ?? '';
    if (headerLine.includes('|') && isTableDivider(dividerLine)) {
      const headerCells = splitTableCells(headerLine);
      const bodyRows: string[][] = [];
      i += 2;

      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        bodyRows.push(splitTableCells(lines[i]));
        i += 1;
      }

      const headHtml = `<tr>${headerCells.map((cell) => `<th style="text-align:left;padding:7px 10px;border:1px solid #334155;color:#e2e8f0;background:#0f172a;">${cell}</th>`).join('')}</tr>`;
      const bodyHtml = bodyRows
        .map((row) => `<tr>${row.map((cell) => `<td style="padding:7px 10px;border:1px solid #334155;color:#cbd5e1;vertical-align:top;">${cell}</td>`).join('')}</tr>`)
        .join('');

      out.push(`<div style="overflow-x:auto;margin:0.65em 0;"><table style="border-collapse:collapse;min-width:360px;width:100%;font-size:12px;"><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`);
      continue;
    }

    out.push(lines[i]);
    i += 1;
  }

  return out.join('\n');
}

export function renderMarkdown(md: string): string {
  if (!md) return '<span style="color:#475569;font-style:italic;">No description yet</span>';
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const withTables = renderTables(escaped);
  return withTables
    .replace(/^### (.+)$/gm, '<h3 style="font-weight:700;margin:0.8em 0 0.3em;font-size:1.05em;color:#cbd5e1;">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-weight:700;margin:0.8em 0 0.3em;font-size:1.2em;color:#f1f5f9;">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-weight:700;margin:0.8em 0 0.3em;font-size:1.4em;color:#f1f5f9;">$1</h1>')
    .replace(/[*][*]([^\n]+?)[*][*]/g, '<strong style="font-weight:700;color:#f1f5f9;">$1</strong>')
    .replace(/__([^\n]+?)__/g, '<strong style="font-weight:700;color:#f1f5f9;">$1</strong>')
    .replace(/[*]([^\n*]+?)[*]/g, '<em style="font-style:italic;color:#94a3b8;">$1</em>')
    // Only treat _ as italic delimiter at word boundaries (not inside identifiers like node_modules).
    .replace(/(?<![a-zA-Z0-9])_([^_\n]+?)_(?![a-zA-Z0-9])/g, '<em style="font-style:italic;color:#94a3b8;">$1</em>')
     
    .replace(/`(.+?)`/g, '<code style="font-family:Menlo,monospace;font-size:12px;background:#1e293b;padding:1px 5px;border-radius:3px;color:#7dd3fc;">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:underline;">$1</a>')
    .replace(/(^|[\s(>])((https?:\/\/)[^\s<>"']+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:underline;word-break:break-all;">$2</a>')
    // Match full 30-char hex task IDs only. The data-task-ref attribute carries the
    // matched ID so App.tsx can open the task panel directly by exact ID match.
    .replace(/(^|[^\w])#([a-f0-9]{30})(?![a-f0-9])/gi, '$1<a href="#task-$2" data-task-ref="$2" style="color:#60a5fa;text-decoration:underline;font-family:Menlo,monospace;">#$2</a>')
    .replace(/^[-*] (.+)$/gm, '<li style="margin:0.2em 0;display:list-item;">$1</li>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #334155;margin:0.8em 0;">')
    // eslint-disable-next-line security/detect-unsafe-regex -- input is our own generated HTML, not raw user input; no ReDoS risk
    .replace(/(<li[^>]*>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul style="padding-left:1.5em;margin:0.4em 0;list-style-type:disc;">${m}</ul>`)
    .replace(/^(?!<[a-z]|$).+$/gm, (line) => `<p style="margin:0.5em 0;">${line}</p>`);
}
