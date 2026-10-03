import { useEffect, useLayoutEffect, useRef } from 'react';
import './scroll-reader.css';
import { storeItem } from '../lib/safe-storage';

// Reading a note: one continuous page that scrolls with the rest of the note
// page. Unlike the book reader's columns, nothing is cut at a page edge, so
// a table, a code block, a formula or a diagram stays whole; one that is
// wider than the page scrolls sideways inside its own box. The position is
// remembered per document.

function load(key: string): number {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '') as { fraction?: number };
    return Math.min(1, Math.max(0, Number(value.fraction) || 0));
  } catch { return 0; }
}

/** The nearest ancestor that scrolls vertically. */
function scrollerOf(node: HTMLElement | null): HTMLElement | null {
  for (let parent = node?.parentElement ?? null; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return parent;
  }
  return null;
}

export function ScrollReader({ html, storageKey, className = '' }: { html: string; storageKey: string; className?: string }) {
  const ref = useRef<HTMLElement | null>(null);

  // Return to where the reader stopped. Images and diagrams arrive late and
  // change the height, so the position is applied again until the reader moves.
  useLayoutEffect(() => {
    const section = ref.current;
    const scroller = scrollerOf(section);
    if (!section || !scroller) return;
    const fraction = load(storageKey);
    let settled = fraction === 0;
    const place = () => { if (!settled) scroller.scrollTop = fraction * Math.max(0, scroller.scrollHeight - scroller.clientHeight); };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(section);
    const settle = () => { settled = true; };
    const timer = window.setTimeout(settle, 3000);
    scroller.addEventListener('wheel', settle, { passive: true });
    scroller.addEventListener('touchstart', settle, { passive: true });
    scroller.addEventListener('keydown', settle);
    scroller.addEventListener('pointerdown', settle);
    let frame = 0;
    const save = () => {
      frame = 0;
      const range = scroller.scrollHeight - scroller.clientHeight;
      storeItem(localStorage, storageKey, JSON.stringify({ chapter: 0, fraction: range > 0 ? scroller.scrollTop / range : 0 }));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(save); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener('wheel', settle);
      scroller.removeEventListener('touchstart', settle);
      scroller.removeEventListener('keydown', settle);
      scroller.removeEventListener('pointerdown', settle);
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [storageKey]);

  // Outline jumps arrive as an event carrying the heading element.
  useEffect(() => {
    const goto = (event: Event) => {
      const target = (event as CustomEvent<Element>).detail;
      if (!ref.current?.contains(target)) return;
      const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
    };
    window.addEventListener('tjuclaw:reader-goto', goto);
    return () => window.removeEventListener('tjuclaw:reader-goto', goto);
  }, []);

  return <section ref={ref} className={`scroll-reader ${className}`} aria-label="阅读">
    <div className="scroll-reader-content markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />
  </section>;
}
