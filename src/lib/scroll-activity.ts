const idleTimers = new WeakMap<Element, number>();
const animations = new WeakMap<Element, Animation>();
const fadingOut = new WeakSet<Element>();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function animateThumb(element: Element, opacity: string, onFinish?: () => void) {
  const current = getComputedStyle(element).getPropertyValue('--scrollbar-visibility').trim() || '0%';
  animations.get(element)?.cancel();
  const animation = element.animate(
    [{ '--scrollbar-visibility': current }, { '--scrollbar-visibility': opacity }],
    { duration: reducedMotion.matches ? 0 : opacity === '0%' ? 300 : 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
  );
  animations.set(element, animation);
  animation.onfinish = () => {
    if (animations.get(element) !== animation) return;
    onFinish?.();
  };
}

export function installScrollActivity() {
  document.addEventListener('scroll', event => {
    const element = event.target instanceof Element ? event.target : document.scrollingElement;
    if (!element || (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth)) return;

    const pending = idleTimers.get(element);
    if (pending) window.clearTimeout(pending);
    if (!element.hasAttribute('data-scroll-active') || fadingOut.has(element)) {
      fadingOut.delete(element);
      element.setAttribute('data-scroll-active', '');
      const opacity = getComputedStyle(element).getPropertyValue('--scrollbar-visible-opacity').trim() || '12%';
      animateThumb(element, opacity);
    }
    idleTimers.set(element, window.setTimeout(() => {
      fadingOut.add(element);
      animateThumb(element, '0%', () => {
        element.removeAttribute('data-scroll-active');
        fadingOut.delete(element);
        animations.get(element)?.cancel();
        animations.delete(element);
      });
    }, 750));
  }, { capture: true, passive: true });
}
