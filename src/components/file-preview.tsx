import { useEffect, useRef, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { downloadFile, type Entry } from '../lib/library';
import { PagedReader } from './paged-reader';
import type { EpubBook } from '../lib/epub';
import './file-preview.css';

type PreviewKind = 'image' | 'audio' | 'video' | 'pdf' | 'epub' | null;

// Loaded only when a book is opened. Outside the component: the React
// compiler cannot compile a dynamic import.
const loadEpub = () => import('../lib/epub');

function previewKind(entry: Entry): PreviewKind {
  const type = entry.content_type?.split(';')[0]?.trim().toLowerCase();
  const name = entry.title.toLowerCase();
  if (type === 'application/pdf' && name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.epub') && ['application/epub+zip', 'application/zip', 'application/octet-stream', ''].includes(type ?? '')) return 'epub';
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type ?? '') && /\.(png|jpe?g|gif|webp)$/.test(name)) return 'image';
  if (['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm'].includes(type ?? '') && /\.(mp3|m4a|ogg|wav|webm)$/.test(name)) return 'audio';
  if (['video/mp4', 'video/webm', 'video/ogg'].includes(type ?? '') && /\.(mp4|webm|ogv)$/.test(name)) return 'video';
  return null;
}

export function FilePreview({ entry, renameRequest, onRename }: { entry: Entry; renameRequest: number; onRename: (name: string) => void }) {
  const kind = previewKind(entry);
  const [url, setUrl] = useState('');
  const [book, setBook] = useState<EpubBook | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState(entry.title);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renameRequest) { nameRef.current?.focus(); nameRef.current?.select(); } }, [renameRequest]);
  const commitName = () => {
    const next = name.trim();
    if (!next) { setName(entry.title); return; }
    if (next !== entry.title) onRename(next);
  };
  useEffect(() => {
    if (!kind) return;
    const controller = new AbortController();
    let objectURL = '';
    fetch(`/api/entries/${entry.id}/file`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('preview_unavailable');
        const blob = await response.blob();
        if (kind === 'epub') {
          // A book opens in the paged reader; the zip is read here, nothing else is fetched.
          const bytes = await blob.arrayBuffer();
          if (new Uint8Array(bytes.slice(0, 2)).join() !== '80,75') throw new Error('invalid_epub');
          const { parseEpub } = await loadEpub();
          const parsed = parseEpub(bytes);
          if (!controller.signal.aborted) setBook(parsed);
          return;
        }
        if (kind === 'pdf' && !(await blob.slice(0, 5).text()).startsWith('%PDF-')) throw new Error('invalid_pdf');
        if (!previewKind({ ...entry, content_type: blob.type })) throw new Error('unsupported_type');
        if (controller.signal.aborted) return;
        objectURL = URL.createObjectURL(blob);
        setUrl(objectURL);
      })
      .catch(() => { if (!controller.signal.aborted) setError('预览暂不可用，可下载原件。'); });
    return () => { controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [entry, kind]);
  if (kind === 'epub' && book) {
    return <div className="file-preview-pane is-book">
      <PagedReader key={entry.id} className="epub-reader" storageKey={`tjuclaw.reader.v1.${entry.id}`} chapters={book.chapters}
        heading={<header className="epub-reader-head"><strong>{book.title}</strong>{book.author ? <small>{book.author}</small> : null}</header>}
        onChapterLink={href => { const index = book.chapters.findIndex(chapter => chapter.href === href.split('#')[0]); return index >= 0 ? index : null; }} />
    </div>;
  }
  return <div className="file-preview-pane">
    <div className="file-preview-heading"><FileText size={19} /><div><input ref={nameRef} aria-label="文件名" value={name} onChange={event => setName(event.target.value)} onBlur={commitName} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setName(entry.title); event.currentTarget.blur(); } }} /><small>{entry.size ? `${(entry.size / 1024 / 1024).toFixed(2)} MB · ` : ''}{entry.content_type || '文件'}</small></div><button type="button" onClick={() => void downloadFile(entry.id).catch(() => setError('下载失败，请稍后再试。'))}><Download size={16} /> 下载原件</button></div>
    {error ? <p className="file-preview-message" role="alert">{error}</p> : null}
    {!kind ? <div className="file-preview-placeholder"><FileText size={30} /><p>此格式暂不支持在线预览</p><small>原件已保留，可下载后用本地应用打开。</small></div>
      : error ? null : !url ? <p className="file-preview-message">{kind === 'epub' ? '正在打开图书…' : '正在加载预览…'}</p>
        : kind === 'image' ? <img src={url} alt={entry.title} />
          : kind === 'audio' ? <audio controls src={url} aria-label={entry.title} />
            : kind === 'video' ? <video controls src={url} aria-label={entry.title} />
              : <iframe title={`${entry.title} PDF 预览`} src={url} sandbox="" />}
  </div>;
}
