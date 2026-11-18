const upstreamOrigin = 'https://auth.tjuclaw.cloud';
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'];

function chatReadTimeout(method, url) {
  const session = /^\/api\/sessions\/[a-f0-9]{32}(?:\/(messages|live))?$/.exec(url.pathname);
  if (!session) return;
  if (method === 'POST' && session[1] === 'messages') return 200_000;
  if (method === 'GET' && session[1] === 'live') return 30_000;
  if (method === 'GET' && !session[1] && url.searchParams.get('settled') === '1') return 95_000;
}

export async function onRequest({ request }) {
  const incoming = new URL(request.url);
  if (incoming.pathname !== '/api' && !incoming.pathname.startsWith('/api/')) {
    return new Response(null, { status: 404 });
  }
  const target = new URL(upstreamOrigin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const name of (headers.get('connection') || '').split(',')) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of hopHeaders) headers.delete(name);
  headers.delete('x-forwarded-for');
  headers.delete('forwarded');
  // EdgeOne defaults to 15s. These routes can legitimately outlive it; keep
  // the normal timeout for unrelated API calls and never retry a send here.
  const readTimeout = chatReadTimeout(request.method, incoming);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
      signal: request.signal,
      duplex: 'half',
      ...(readTimeout && { eo: { timeoutSetting: { readTimeout } } }),
    });
    // Clone the native header list without flattening separate Set-Cookie fields.
    const response = new Response(upstream.body, upstream);
    for (const name of hopHeaders) response.headers.delete(name);
    response.headers.set('Cache-Control', 'no-store');
    // Only a forwarded 502 has an upstream response to distinguish from our catch below.
    if (response.status === 502) response.headers.set('X-TJUClaw-API-Response', 'forwarded');
    return response;
  } catch {
    return Response.json({ error: { id: 'upstream_unavailable' } }, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
