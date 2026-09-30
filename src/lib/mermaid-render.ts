// Mermaid diagrams render to SVG on demand; the library loads only once a
// page shows a diagram. securityLevel 'strict' keeps labels as text (no
// HTML, no click handlers).

type Mermaid = typeof import('mermaid').default;
let loading: Promise<Mermaid> | null = null;
let theme = '';
let counter = 0;

function load(): Promise<Mermaid> {
  loading ??= import('mermaid').then(module => module.default);
  return loading;
}

const dark = () => document.documentElement.dataset.theme === 'dark'
  || (document.documentElement.dataset.theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);

/** SVG markup for a diagram, or throws with Mermaid's parse error. */
export async function renderMermaid(source: string): Promise<string> {
  const mermaid = await load();
  const wanted = dark() ? 'dark' : 'neutral';
  if (theme !== wanted) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: wanted, fontFamily: 'inherit' });
    theme = wanted;
  }
  counter += 1;
  const { svg } = await mermaid.render(`tjuclaw-mermaid-${counter}`, source);
  return svg;
}

/** Replaces .mermaid-block placeholders inside root with their diagrams. */
export function renderMermaidBlocks(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('.mermaid-block:not([data-rendered])').forEach(block => {
    block.dataset.rendered = 'pending';
    const source = block.querySelector('code')?.textContent ?? '';
    renderMermaid(source).then(svg => {
      block.innerHTML = svg;
      block.dataset.rendered = 'true';
    }).catch(() => { block.dataset.rendered = 'error'; });
  });
}
