import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

// What this build is: the package version, and the commit it was built from
// (several deployments can share one version).
const packageVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
function buildCommit(): string {
  const fromCI = process.env.GITHUB_SHA;
  if (fromCI && /^[0-9a-f]{40}$/.test(fromCI)) return fromCI.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

// Writes dist/sw.js once the build is on disk. The shell it precaches is
// exactly what index.html asks for up front (entry, workspace graph, styles);
// everything else under /assets/ is cached when first used.
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'tjuclaw-service-worker',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir; },
    closeBundle() {
      const html = readFileSync(join(outDir, 'index.html'), 'utf8');
      const shell = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]!))];
      const precache = ['/index.html', ...shell];
      const assets = readdirSync(join(outDir, 'assets')).map(name => `/assets/${name}`).sort();
      const version = createHash('sha256').update(html).update(assets.join('\n')).digest('hex').slice(0, 16);
      const source = readFileSync(fileURLToPath(new URL('./src/service-worker.js', import.meta.url)), 'utf8');
      writeFileSync(join(outDir, 'sw.js'), `const BUILD = ${JSON.stringify({ version, precache, assets })};\n${source}`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'audit' ? [] : [preloadWorkspace(), serviceWorker()]), ...(mode === 'audit'
    ? [auditServer(fileURLToPath(new URL('../private/audit/', import.meta.url)))] : [])],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  define: { __APP_VERSION__: JSON.stringify(packageVersion), __APP_COMMIT__: JSON.stringify(buildCommit()) },
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
  // pako is first imported by the lazily loaded Git replica; listing it avoids
  // a dev-server reload when that happens.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'], include: ['pako'] },
  worker: { format: 'es' },
}));
