import React from "react";
import { X, Download, FileText } from "lucide-react";
import { MarkdownPreview } from "../../MarkdownPreview";
import { ModalBase } from "./ModalBase";

interface Props {
  open: boolean;
  name: string;
  url: string;
  onClose: () => void;
}

function isImage(name: string) {
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);
}
function isMarkdown(name: string) {
  return /\.md$/i.test(name);
}
function isJson(name: string) {
  return /\.json$/i.test(name);
}

type JsonToken = {
  type: "key" | "string" | "number" | "bool" | "null" | "punct";
  value: string;
};
type TokenizedLine = JsonToken[];

/** Tokenize a single line of formatted JSON for React rendering. */
function tokenizeLine(line: string): TokenizedLine {
  const tokens: JsonToken[] = [];
  let i = 0;
  while (i < line.length) {
    // Whitespace
    const wsMatch = line.slice(i).match(/^(\s+)/);
    if (wsMatch) {
      tokens.push({ type: "punct", value: wsMatch[1] });
      i += wsMatch[1].length;
      continue;
    }
    // Punctuation
    const punctMatch = line.slice(i).match(/^([{}[\]:,])/);
    if (punctMatch) {
      tokens.push({ type: "punct", value: punctMatch[1] });
      i += 1;
      continue;
    }
    // String (key or value)
    const strMatch = line.slice(i).match(/^"([^"\\]|\\.)*"/);
    if (strMatch) {
      const raw = strMatch[0];
      const isKey = line[i + raw.length] === ":";
      // Strip quotes for display
      const inner = raw.slice(1, -1);
      // Escape HTML entities for React text rendering
      const escaped = inner
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      tokens.push({ type: isKey ? "key" : "string", value: escaped });
      i += raw.length;
      continue;
    }
    // Number
    const numMatch = line.slice(i).match(/^(-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/);
    if (numMatch) {
      tokens.push({ type: "number", value: numMatch[1] });
      i += numMatch[1].length;
      continue;
    }
    // Boolean
    const boolMatch = line.slice(i).match(/^(true|false)/);
    if (boolMatch) {
      tokens.push({ type: "bool", value: boolMatch[1] });
      i += boolMatch[1].length;
      continue;
    }
    // Null
    const nullMatch = line.slice(i).match(/^(null)/);
    if (nullMatch) {
      tokens.push({ type: "null", value: nullMatch[1] });
      i += 1;
      continue;
    }
    // Fallback: single char
    tokens.push({ type: "punct", value: line[i] });
    i++;
  }
  return tokens;
}

const TOKEN_STYLES: Record<JsonToken["type"], React.CSSProperties> = {
  key: { color: "#c084fc" },
  string: { color: "#86efac" },
  number: { color: "#67e8f9" },
  bool: { color: "#fb923c" },
  null: { color: "#f87171" },
  punct: { color: "inherit" },
};

function JsonLine({ tokens }: { tokens: TokenizedLine }) {
  return (
    <div>
      {tokens.map((tok, i) => (
        <span key={i} style={TOKEN_STYLES[tok.type]}>
          {tok.value}
        </span>
      ))}
    </div>
  );
}

export function FilePreviewModal({ open, name, url, onClose }: Props) {
  const [mdContent, setMdContent] = React.useState<string | null>(null);
  const [jsonLines, setJsonLines] = React.useState<TokenizedLine[] | null>(
    null,
  );
  const [jsonError, setJsonError] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open || !url) return;
    setJsonError(false);
    if (isMarkdown(name)) {
      setLoading(true);
      setMdContent(null);
      fetch(url)
        .then((r) => r.text())
        .then((text) => {
          setMdContent(text);
          setLoading(false);
        })
        .catch(() => {
          setMdContent("Error loading file.");
          setLoading(false);
        });
    } else if (isJson(name)) {
      setLoading(true);
      setJsonLines(null);
      fetch(url)
        .then((r) => r.text())
        .then((text) => {
          try {
            const parsed = JSON.parse(text);
            const formatted = JSON.stringify(parsed, null, 2);
            const lines = formatted.split("\n").map(tokenizeLine);
            setJsonLines(lines);
          } catch {
            setJsonError(true);
          }
          setLoading(false);
        })
        .catch(() => {
          setJsonError(true);
          setLoading(false);
        });
    } else {
      setMdContent(null);
      setJsonLines(null);
    }
  }, [open, name, url]);

  return (
    <ModalBase
      open={open}
      onClose={onClose}
      id="file-preview-modal"
      width="min(1100px, 95vw)"
      maxHeight="88vh"
      boxStyle={{ display: "flex", flexDirection: "column" }}
      icon={<FileText className="w-4 h-4 text-slate-400" />}
      title={name}
      headerActions={
        <>
          <a
            href={url}
            download={name}
            className="text-slate-400 hover:text-slate-200 transition-colors p-1.5 rounded-md hover:bg-slate-700/60"
            title="Download"
          >
            <Download className="w-4 h-4" />
          </a>
          <button
            id="file-preview-close"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 transition-colors p-1.5 rounded-md hover:bg-slate-700/60"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </>
      }
      footer={
        <>
          <a
            href={url}
            download={name}
            className="flex items-center gap-1.5 border border-slate-700 hover:bg-slate-800 text-slate-300 text-sm px-3 py-1.5 rounded-lg transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </a>
          <button
            id="file-preview-close-footer"
            onClick={onClose}
            className="border border-slate-700 hover:bg-slate-800 text-slate-300 text-sm px-4 py-1.5 rounded-lg transition-colors"
          >
            Close
          </button>
        </>
      }
    >
      <div
        className="flex-1 overflow-auto"
        style={{ minHeight: 0, padding: "16px 20px" }}
      >
        {isImage(name) && (
          <div
            style={{
              borderRadius: 8,
              overflow: "hidden",
              border: "1px solid var(--p-border)",
              background: "var(--p-card)",
              display: "inline-block",
              width: "100%",
            }}
          >
            <img
              src={url}
              alt={name}
              style={{
                maxWidth: "100%",
                display: "block",
                margin: "0 auto",
                objectFit: "contain",
              }}
            />
          </div>
        )}
        {isMarkdown(name) && loading && (
          <p className="text-xs text-slate-500 py-4">Loading…</p>
        )}
        {isMarkdown(name) && !loading && mdContent !== null && (
          <div
            id="file-preview-md"
            style={{
              background: "var(--p-input)",
              border: "1px solid var(--p-border-s)",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 13,
              color: "var(--p-text-sub)",
              lineHeight: 1.65,
            }}
          >
            <MarkdownPreview markdown={mdContent} />
          </div>
        )}
        {isJson(name) && loading && (
          <p className="text-xs text-slate-500 py-4">Loading…</p>
        )}
        {isJson(name) && !loading && jsonError && (
          <p className="text-xs text-red-400 py-4">
            Error loading or parsing JSON file.
          </p>
        )}
        {isJson(name) && !loading && jsonLines !== null && (
          <pre
            id="file-preview-json"
            style={{
              background: "var(--p-input)",
              border: "1px solid var(--p-border-s)",
              borderRadius: 8,
              padding: "12px 16px",
              fontSize: 12,
              lineHeight: 1.6,
              overflow: "auto",
              maxHeight: "70vh",
              margin: 0,
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            }}
          >
            {jsonLines.map((tokens, i) => (
              <JsonLine key={i} tokens={tokens} />
            ))}
          </pre>
        )}
        {!isImage(name) && !isMarkdown(name) && !isJson(name) && (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-slate-500">
            <FileText className="w-10 h-10 opacity-40" />
            <p className="text-sm">Preview not available for this file type.</p>
            <a
              href={url}
              download={name}
              className="flex items-center gap-1.5 text-violet-400 hover:text-violet-300 hover:underline text-sm transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Download file
            </a>
          </div>
        )}
      </div>
    </ModalBase>
  );
}
