import { useEffect, type RefObject } from 'react';

// A bottom sheet the finger can pull down by its handle (an element marked
// data-sheet-handle, with touch-action: none so the browser does not take
// the gesture for a scroll). The sheet follows through an inline transform
// only, no re-render; released far or fast enough it slides out and then
// closes, otherwise it springs back.

const EASE = 'cubic-bezier(.32, .72, 0, 1)';

/** Slides a sheet out of view, fades its veil, then calls onClose. */
export function dismissSheet(sheet: HTMLElement | null, veil: HTMLElement | null, onClose: () => void) {
  if (!sheet || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return; }
  sheet.style.animation = 'none';
  sheet.style.transition = `transform 240ms ${EASE}`;
  sheet.style.transform = 'translate3d(0, 100%, 0)';
  if (veil) {
    veil.style.animation = 'none';
    veil.style.transition = 'opacity 240ms ease';
    veil.style.opacity = '0';
  }
  window.setTimeout(onClose, 230);
}

export function useSheetGesture({ sheet, veil, enabled, onClose }: {
  sheet: RefObject<HTMLElement | null>;
  veil?: RefObject<HTMLElement | null>;
  enabled: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const element = sheet.current;
    if (!enabled || !element) return;
    let start: { id: number; y: number; x: number; time: number } | null = null;
    let dragging = false;
    let dy = 0;

    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !(event.target as Element).closest?.('[data-sheet-handle]')) return;
      start = { id: event.pointerId, y: event.clientY, x: event.clientX, time: event.timeStamp };
      dragging = false;
      dy = 0;
    };
    const move = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      const ddy = event.clientY - start.y;
      if (!dragging) {
        if (Math.abs(ddy) < 8 && Math.abs(event.clientX - start.x) < 8) return;
        if (ddy <= 0 || Math.abs(ddy) < Math.abs(event.clientX - start.x)) { start = null; return; }
        dragging = true;
        element.style.animation = 'none';
      }
      dy = Math.max(0, ddy);
      element.style.transition = 'none';
      element.style.transform = `translate3d(0, ${dy}px, 0)`;
      const shade = veil?.current;
      if (shade) {
        shade.style.animation = 'none';
        shade.style.transition = 'none';
        shade.style.opacity = String(Math.max(0, 1 - dy / element.offsetHeight));
      }
    };
    const up = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      const elapsed = Math.max(event.timeStamp - start.time, 16);
      start = null;
      if (!dragging) return;
      dragging = false;
      if (event.type !== 'pointercancel' && (dy > element.offsetHeight * 0.3 || (dy > 24 && dy / elapsed > 0.5))) {
        dismissSheet(element, veil?.current ?? null, onClose);
        return;
      }
      element.style.transition = `transform 280ms ${EASE}`;
      element.style.transform = 'translate3d(0, 0, 0)';
      const shade = veil?.current;
      if (shade) { shade.style.transition = 'opacity 200ms ease'; shade.style.opacity = '1'; }
    };

    element.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      element.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [sheet, veil, enabled, onClose]);
}
