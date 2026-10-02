import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, List } from 'lucide-react';
import './paged-reader.css';

// Reading like a book: the text is laid out in columns one page wide and
// turned page by page (arrows, Space, PageUp/PageDown, the page edges, or a
// swipe). A book with chapters turns into the next chapter at the last page.
// The position is remembered per document.

export interface ReaderChapter { id: string; title: string; html: string }

const GAP = 72;

function load(key: string): { chapter: number; fraction: number } {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '') as { chapter?: number; fraction?: number };
    return { chapter: Math.max(0, Number(value.chapter) || 0), fraction: Math.min(1, Math.max(0, Number(value.fraction) || 0)) };
  } catch { return { chapter: 0, fraction: 0 }; }
}

export function PagedReader({ chapters, storageKey, className = '', heading, onChapterLink }: {
  chapters: ReaderChapter[];
  storageKey: string;
  className?: string;
  heading?: ReactNode;
  /** A link inside the text to another chapter (EPUB); returns the chapter index. */
  onChapterLink?: (href: string) => number | null;
}) {
  const [saved] = useState(() => load(storageKey));
  const [chapter, setChapter] = useState(() => Math.min(saved.chapter, chapters.length - 1));
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [tocOpen, setTocOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pendingFraction = useRef<number | null>(saved.fraction);
  const pageRef = useRef(0);
  useEffect(() => { pageRef.current = page; }, [page]);

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const width = viewport.clientWidth;
    setWidth(width);
    content.style.columnWidth = `${width}px`;
    content.style.columnGap = `${GAP}px`;
    const count = Math.max(1, Math.round((content.scrollWidth + GAP) / (width + GAP)));
    setPages(count);
    if (pendingFraction.current !== null) {
      setPage(Math.min(count - 1, Math.round(pendingFraction.current * (count - 1))));
      pendingFraction.current = null;
    } else setPage(current => Math.min(current, count - 1));
  }, []);

  useLayoutEffect(() => { measure(); }, [chapter, measure]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      // Keep the reading position through a resize or late images/diagrams.
      if (pendingFraction.current === null && pages > 1) pendingFraction.current = pageRef.current / (pages - 1);
      measure();
    });
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [measure, pages]);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ chapter, fraction: pages > 1 ? page / (pages - 1) : 0 })); } catch { /* position lasts for this page */ }
  }, [storageKey, chapter, page, pages]);

  const goChapter = useCallback((index: number, atEnd = false) => {
    if (index < 0 || index >= chapters.length) return;
    pendingFraction.current = atEnd ? 1 : 0;
    setChapter(index);
    setTocOpen(false);
  }, [chapters.length]);
  const turn = useCallback((step: 1 | -1) => {
    const next = pageRef.current + step;
    if (next >= 0 && next < pages) setPage(next);
    else if (step > 0) goChapter(chapter + 1);
    else goChapter(chapter - 1, true);
  }, [pages, chapter, goChapter]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)) { event.preventDefault(); turn(1); }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) { event.preventDefault(); turn(-1); }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [turn]);

  const touch = useRef<{ x: number; y: number } | null>(null);
  const current = chapters[chapter];
  const offset = page * (width + GAP);

  return <section className={`paged-reader ${className}`} aria-label="阅读">
    {heading}
    <div className="paged-reader-viewport" ref={viewportRef}
      onClick={event => {
        const target = event.target as Element;
        const link = target.closest('a');
        if (link) {
          const href = link.getAttribute('data-epub-href');
          if (href && onChapterLink) { event.preventDefault(); const index = onChapterLink(href); if (index !== null) goChapter(index); }
          return;
        }
        if (target.closest('button, summary, input, .code-block, .mermaid-block')) return;
        const box = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width;
        if (x < .3) turn(-1);
        else if (x > .7) turn(1);
      }}
      onTouchStart={event => { touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }; }}
      onTouchEnd={event => {
        const start = touch.current;
        touch.current = null;
        if (!start) return;
        const dx = event.changedTouches[0].clientX - start.x;
        const dy = event.changedTouches[0].clientY - start.y;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) turn(dx < 0 ? 1 : -1);
      }}>
      <div className="paged-reader-content markdown-preview" ref={contentRef} style={{ transform: `translateX(${-offset}px)` }}
        dangerouslySetInnerHTML={{ __html: current?.html ?? '' }} />
    </div>
    <footer className="paged-reader-bar">
      <button type="button" onClick={() => turn(-1)} disabled={page === 0 && chapter === 0} aria-label="上一页" title="上一页（←）"><ChevronLeft size={16} /></button>
      {chapters.length > 1 ? <div className="paged-reader-toc">
        <button type="button" onClick={() => setTocOpen(open => !open)} aria-expanded={tocOpen} aria-label="目录"><List size={15} /><span>{current?.title}</span></button>
        {tocOpen ? <ol className="paged-reader-toc-list" aria-label="章节">
          {chapters.map((item, index) => <li key={item.id}><button type="button" aria-current={index === chapter ? 'true' : undefined} onClick={() => goChapter(index)}>{item.title}</button></li>)}
        </ol> : null}
      </div> : null}
      <span className="paged-reader-count" aria-live="polite">{page + 1} / {pages}{chapters.length > 1 ? ` · ${chapter + 1}/${chapters.length} 章` : ''}</span>
      <div className="paged-reader-progress" aria-hidden="true"><i style={{ width: `${((chapter + (pages > 1 ? page / (pages - 1) : 1)) / chapters.length) * 100}%` }} /></div>
      <button type="button" onClick={() => turn(1)} disabled={page >= pages - 1 && chapter >= chapters.length - 1} aria-label="下一页" title="下一页（→）"><ChevronRight size={16} /></button>
    </footer>
  </section>;
}
