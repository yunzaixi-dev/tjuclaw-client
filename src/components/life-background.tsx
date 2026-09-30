import { useEffect, useRef } from 'react';

// A quiet Conway's Game of Life behind the conversation: small rounded cells
// that fade in as they are born and out as they die. It is masked away from
// the centre (where the text is), pauses in hidden tabs, stays still for
// reduced motion, and reseeds with gliders when the board settles.

const CELL = 16;
const STEP_MS = 520;
const GLIDER = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];

export function LifeBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let columns = 0;
    let rows = 0;
    let cells = new Uint8Array(0);
    // Per-cell opacity, eased toward alive (1) or dead (0) every frame.
    let shown = new Float32Array(0);
    let quiet = 0;
    let frame = 0;
    let lastStep = 0;
    let color = '0 0 0';

    const index = (x: number, y: number) => ((y + rows) % rows) * columns + ((x + columns) % columns);
    const glider = (x: number, y: number) => {
      const flipX = Math.random() < .5 ? -1 : 1;
      const flipY = Math.random() < .5 ? -1 : 1;
      for (const [dx, dy] of GLIDER) cells[index(x + dx * flipX, y + dy * flipY)] = 1;
    };
    const seed = () => {
      for (let i = 0; i < cells.length; i += 1) cells[i] = Math.random() < .16 ? 1 : 0;
      for (let i = 0; i < 4; i += 1) glider(Math.floor(Math.random() * columns), Math.floor(Math.random() * rows));
    };
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      columns = Math.max(1, Math.ceil(width / CELL));
      rows = Math.max(1, Math.ceil(height / CELL));
      cells = new Uint8Array(columns * rows);
      shown = new Float32Array(columns * rows);
      seed();
      const probe = getComputedStyle(canvas).color;
      const match = /(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/.exec(probe);
      color = match ? `${match[1]} ${match[2]} ${match[3]}` : '0 0 0';
    };
    const step = () => {
      const next = new Uint8Array(cells.length);
      let changes = 0;
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < columns; x += 1) {
          let around = 0;
          for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if (dx || dy) around += cells[index(x + dx, y + dy)];
          const alive = cells[y * columns + x];
          const born = around === 3 || (alive && around === 2) ? 1 : 0;
          next[y * columns + x] = born;
          if (born !== alive) changes += 1;
        }
      }
      cells = next;
      // A board that barely changes gets fresh gliders.
      quiet = changes < columns * rows * .004 ? quiet + 1 : 0;
      if (quiet > 6) { glider(Math.floor(Math.random() * columns), Math.floor(Math.random() * rows)); quiet = 0; }
    };
    const draw = (settle: boolean) => {
      const { width, height } = canvas.getBoundingClientRect();
      context.clearRect(0, 0, width, height);
      const size = CELL - 5;
      for (let i = 0; i < cells.length; i += 1) {
        const target = cells[i];
        shown[i] = settle ? target : shown[i] + (target - shown[i]) * .12;
        if (shown[i] < .02) continue;
        const x = (i % columns) * CELL + 2.5;
        const y = Math.floor(i / columns) * CELL + 2.5;
        context.fillStyle = `rgb(${color} / ${(shown[i] * .5).toFixed(3)})`;
        context.beginPath();
        context.roundRect(x, y, size, size, 3);
        context.fill();
      }
    };
    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (time - lastStep > STEP_MS) { step(); lastStep = time; }
      draw(false);
    };

    resize();
    if (still) draw(true);
    else frame = requestAnimationFrame(loop);
    const observer = new ResizeObserver(() => { resize(); if (still) draw(true); });
    observer.observe(canvas);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);

  return <canvas ref={canvasRef} className="life-background" aria-hidden="true" />;
}
