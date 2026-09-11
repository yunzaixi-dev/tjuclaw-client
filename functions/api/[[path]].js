const upstreamOrigin = 'https://auth.tjuclaw.cloud';
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'];

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
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
      signal: request.signal,
      duplex: 'half',
    });
    // Clone the native header list without flattening separate Set-Cookie fields.
    const response = new Response(upstream.body, upstream);
    for (const name of hopHeaders) response.headers.delete(name);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch {
    return Response.json({ error: { id: 'upstream_unavailable' } }, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
