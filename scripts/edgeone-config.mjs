import { writeFile } from 'node:fs/promises';

export function createEdgeoneConfig(sandboxOrigin = '') {
  let gateway = '';
  if (sandboxOrigin) {
    let parsed;
    try { parsed = new URL(sandboxOrigin); }
    catch { throw new Error('EDGEONE_SANDBOX_ORIGIN must be an exact HTTPS origin'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== sandboxOrigin ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('EDGEONE_SANDBOX_ORIGIN must be an exact HTTPS origin');
    }
    gateway = ` ${parsed.origin}`;
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self'${gateway}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    outputDirectory: 'assets',
    rewrites: [{ source: '/*', destination: '/index.html' }],
    headers: [{
      source: '/*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    }],
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv.length !== 3 && (process.argv.length !== 4 || process.argv[3] !== '--direct-upload')) {
    throw new Error('Usage: node scripts/edgeone-config.mjs OUTPUT [--direct-upload]');
  }
  const config = createEdgeoneConfig(process.env.EDGEONE_SANDBOX_ORIGIN);
  if (process.argv[3] === '--direct-upload') delete config.outputDirectory;
  await writeFile(process.argv[2], `${JSON.stringify(config)}\n`, { flag: 'wx' });
}
