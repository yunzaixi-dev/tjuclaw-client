const paths = ['/auth/login', '/workspace', '/api/healthz', '/api/auth/session'];

export async function checkPublicWeb(origin, sandboxOrigin = '', fetchImpl = fetch) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin) throw new Error('Invalid public Web origin');
  const expectedConnect = `'self'${sandboxOrigin ? ` ${sandboxOrigin}` : ''}`;
  for (const path of paths) {
    const response = await fetchImpl(new URL(path, base), {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'manual',
      headers: { Accept: path.startsWith('/api/') ? 'application/json' : 'text/html' },
      signal: AbortSignal.timeout(10000),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (path.startsWith('/api/')) {
      const status = path === '/api/healthz' ? 200 : 401;
      if (response.status !== status || !contentType.startsWith('application/json')) {
        throw new Error(`${path}: expected ${status} JSON, got ${response.status} ${contentType}`);
      }
      const data = await response.json();
      if (path === '/api/healthz' ? data?.status !== 'ok' : data?.error?.id !== 'session_required') {
        throw new Error(`${path}: unexpected API response`);
      }
      continue;
    }
    if (response.status !== 200 || !contentType.startsWith('text/html')) {
      throw new Error(`${path}: expected 200 HTML, got ${response.status} ${contentType}`);
    }
    const csp = response.headers.get('content-security-policy') ?? '';
    const connect = csp.match(/(?:^|;\s*)connect-src\s+([^;]+)/)?.[1]?.trim();
    if (connect !== expectedConnect || !csp.includes("frame-ancestors 'none'")) {
      throw new Error(`${path}: missing or incorrect Content-Security-Policy`);
    }
    if (!(await response.text()).includes('<div id="root"></div>')) {
      throw new Error(`${path}: not the Web application`);
    }
  }
}

export async function waitForPublicWeb(origin, sandboxOrigin = '', attempts = 18, fetchImpl = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  let lastError;
  let consecutive = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await checkPublicWeb(origin, sandboxOrigin, fetchImpl);
      if (++consecutive === 3) return;
    } catch (error) {
      lastError = error;
      consecutive = 0;
    }
    if (attempt + 1 < attempts) await pause(5000);
  }
  throw lastError ?? new Error('Public Web did not remain healthy for three consecutive checks');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/edgeone-smoke.mjs HTTPS_ORIGIN');
  await waitForPublicWeb(process.argv[2], process.env.EDGEONE_SANDBOX_ORIGIN);
  console.log('Web SPA, CSP and anonymous API routing verified on the public origin');
}
