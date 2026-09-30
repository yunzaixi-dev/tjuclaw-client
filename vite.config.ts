import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { auditServer } from './audit-server.ts';

// The entry imports the workspace lazily, so by default its code is only
// requested after index.js has downloaded and run: one extra round trip on
// the first screen. Listing the workspace's static module graph as
// modulepreload/preload links lets the browser fetch it all in parallel with
// the entry (and warms the cache on the sign-in page for after sign-in).
function preloadWorkspace(): Plugin {
  return {
    name: 'tjuclaw-preload-workspace',
    apply: 'build',
    transformIndexHtml: { order: 'post', handler(html, context) {
      const bundle = context.bundle;
      if (!bundle) return html;
      const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
      const root = chunks.find(chunk => chunk.facadeModuleId?.endsWith('/src/workspace.tsx'));
      if (!root) return html;
      const seen = new Set<string>();
      const css = new Set<string>();
      const walk = (name: string) => {
        if (seen.has(name)) return;
        seen.add(name);
        const chunk = bundle[name];
        if (chunk?.type !== 'chunk') return;
        chunk.viteMetadata?.importedCss.forEach(file => css.add(file));
        chunk.imports.forEach(walk);
      };
      walk(root.fileName);
      const present = (file: string) => html.includes(`/${file}"`);
      const links = [
        ...[...seen].filter(file => !present(file)).map(file => `<link rel="modulepreload" crossorigin href="/${file}">`),
        ...[...css].filter(file => !present(file)).map(file => `<link rel="preload" as="style" href="/${file}">`),
      ];
      return html.replace(/\s*<\/head>/, `\n    ${links.join('\n    ')}\n  </head>`);
    } },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'audit' ? [] : [preloadWorkspace()]), ...(mode === 'audit'
    ? [auditServer(fileURLToPath(new URL('../private/audit/', import.meta.url)))] : [])],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  clearScreen: false,
  server: {
    host: mode === 'audit' ? '127.0.0.1' : process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: mode === 'audit' ? 1421 : 5173,
    strictPort: true,
    proxy: mode === 'audit' ? undefined : {
      '/api': { target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:8080', rewrite: path => path.replace(/^\/api/, '') },
    },
    watch: { ignored: ['**/src-tauri/**'] },
    fs: { deny: ['.env', '.env.*', '**/*.{crt,pem,key}', '**/.git/**', '**/private/**', '**/research/**', '**/*.zip'] },
  },
  preview: {
    proxy: { '/api': { target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:8080', rewrite: path => path.replace(/^\/api/, '') } },
  },
  build: { target: ['es2022', 'chrome105', 'safari15'] },
  // sqlite-wasm locates its .wasm relative to its own module; keep it out of prebundling.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
}));
