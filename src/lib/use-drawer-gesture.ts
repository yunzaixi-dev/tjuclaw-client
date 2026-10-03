import { useEffect, type RefObject } from 'react';

// A phone drawer that follows the finger. A horizontal swipe on the open
// drawer or its backdrop drags it closed; one from the screen's left edge
// drags it open. While a finger is down the drawer moves through inline
// styles only, so nothing re-renders per frame; on release it settles by
// distance and speed, and the CSS transition finishes from where it is.

const EDGE = 24;
const SLOP = 8;
const FLING = 0.45; // px per ms

type Drag = {
  id: number;
  x: number;
  y: number;
  time: number;
  width: number;
  opening: boolean;
  horizontal: boolean | null;
  dx: number;
  lastX: number;
  lastTime: number;
  velocity: number;
};

export function useDrawerGesture({ root, drawer, backdrop, open, enabled, onOpenChange }: {
  root: RefObject<HTMLElement | null>;
  drawer: RefObject<HTMLElement | null>;
  backdrop: RefObject<HTMLElement | null>;
  open: boolean;
  enabled: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    // Listens on the document and finds the elements per gesture: the shell
    // may mount after this effect (a loading screen comes first).
    let drag: Drag | null = null;
    let panel: HTMLElement | null = null;
    let suppressClick = false;

    const paint = (offset: number, width: number) => {
      if (!panel) return;
      // offset: how far the drawer is from fully open, 0 … -width.
      const shown = Math.max(0, Math.min(1, 1 + offset / width));
      panel.style.transition = 'none';
      panel.style.transform = `translate3d(${Math.round(offset)}px, 0, 0)`;
      const shade = backdrop.current;
      if (shade) {
        shade.style.transition = 'none';
        shade.style.opacity = String(shown);
        shade.style.visibility = 'visible';
      }
    };
    const release = () => {
      // Clearing inline styles in the same frame as the state change lets
      // the CSS transition run from the finger's position.
      for (const element of [panel ?? drawer.current, backdrop.current]) {
        if (!element) continue;
        element.style.transition = '';
        element.style.transform = '';
        element.style.opacity = '';
        element.style.visibility = '';
      }
    };

    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || drag) return;
      const target = event.target as Node;
      panel = drawer.current;
      if (!panel || !root.current?.contains(target)) return;
      const width = panel.getBoundingClientRect().width || 300;
      const onDrawer = panel.contains(target) || backdrop.current?.contains(target);
      if (open && !onDrawer) return;
      if (!open && event.clientX > EDGE) return;
      drag = {
        id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, width,
        opening: !open, horizontal: null, dx: 0, lastX: event.clientX, lastTime: event.timeStamp, velocity: 0,
      };
    };

    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (drag.horizontal === null) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // A mostly vertical movement is a scroll: leave it to the list.
        drag.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2 && (drag.opening ? dx > 0 : dx < 0);
        if (!drag.horizontal) { drag = null; return; }
        try { (event.target as Element).setPointerCapture?.(event.pointerId); } catch { /* still tracked on host */ }
      }
      // Speed is sampled over at least 8 ms: events arriving almost together
      // would otherwise read as an enormous fling.
      const elapsed = event.timeStamp - drag.lastTime;
      if (elapsed >= 8) {
        drag.velocity = drag.velocity * 0.3 + ((event.clientX - drag.lastX) / elapsed) * 0.7;
        drag.lastX = event.clientX;
        drag.lastTime = event.timeStamp;
      }
      drag.dx = dx;
      const offset = drag.opening ? Math.min(0, -drag.width + dx) : Math.min(0, dx);
      paint(offset, drag.width);
    };

    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const finished = drag;
      drag = null;
      if (!finished.horizontal) return;
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
      const travelled = Math.abs(finished.dx) / finished.width;
      const flung = Math.abs(finished.dx) > 24 && (finished.opening ? finished.velocity > FLING : finished.velocity < -FLING);
      const commit = event.type !== 'pointercancel' && (travelled > 0.35 || flung);
      release();
      if (commit) onOpenChange(finished.opening);
    };

    // A finished drag is not a tap on whatever row it ended over.
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    };

    document.addEventListener('pointerdown', down, { passive: true });
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('click', click, true);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('click', click, true);
      release();
    };
  }, [root, drawer, backdrop, open, enabled, onOpenChange]);
}
