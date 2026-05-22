import React from 'react';
import { X, Download, FileText } from 'lucide-react';
import { MarkdownPreview } from '../../MarkdownPreview';
import { ModalBase } from './ModalBase';

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

export function FilePreviewModal({ open, name, url, onClose }: Props) {
  const [mdContent, setMdContent] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open || !url) return;
    if (isMarkdown(name)) {
      setLoading(true);
      setMdContent(null);
      fetch(url)
        .then(r => r.text())
        .then(text => { setMdContent(text); setLoading(false); })
        .catch(() => { setMdContent('Error loading file.'); setLoading(false); });
    } else {
      setMdContent(null);
    }
  }, [open, name, url]);

  return (
    <ModalBase
      open={open}
      onClose={onClose}
      id="file-preview-modal"
      width="min(700px, 95vw)"
      maxHeight="88vh"
      boxStyle={{ display: 'flex', flexDirection: 'column' }}
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
      <div className="flex-1 overflow-auto" style={{ minHeight: 0, padding: '16px 20px' }}>
        {isImage(name) && (
          <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--p-border)', background: 'var(--p-card)', display: 'inline-block', width: '100%' }}>
            <img
              src={url}
              alt={name}
              style={{ maxWidth: '100%', display: 'block', margin: '0 auto', objectFit: 'contain' }}
            />
          </div>
        )}
        {isMarkdown(name) && loading && (
          <p className="text-xs text-slate-500 py-4">Loading…</p>
        )}
        {isMarkdown(name) && !loading && mdContent !== null && (
          <div
            id="file-preview-md"
            style={{ background: 'var(--p-input)', border: '1px solid var(--p-border-s)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--p-text-sub)', lineHeight: 1.65 }}
          >
            <MarkdownPreview markdown={mdContent} />
          </div>
        )}
        {!isImage(name) && !isMarkdown(name) && (
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

