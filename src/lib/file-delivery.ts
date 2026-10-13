type Download = { blob: Blob; filename: string };
type Options = {
  signal?: AbortSignal;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
  origin?: string;
  native?: boolean;
  fallback?: string;
};

export class FileFetchError extends Error {
  constructor(public status: number) { super('file_unavailable'); }
}

type Ticket = { url: string; expires_at: string; filename: string; content_type: string; size: number };

function ticket(value: unknown): Ticket {
  if (!value || typeof value !== 'object') throw new Error('invalid_file_delivery');
  const download = (value as { download?: unknown }).download;
  if (!download || typeof download !== 'object') throw new Error('invalid_file_delivery');
  const d = download as Record<string, unknown>;
  if (typeof d.url !== 'string' || typeof d.expires_at !== 'string' || typeof d.filename !== 'string' ||
    typeof d.content_type !== 'string' || !d.content_type.startsWith('image/') ||
    !Number.isSafeInteger(d.size) || (d.size as number) < 1 || (d.size as number) > 8 * 1024 * 1024) {
    throw new Error('invalid_file_delivery');
  }
  const url = new URL(d.url);
  // Only the S3 R2 endpoint issued by our authenticated API. Public custom
  // domains and user-supplied image hosts never receive this download request.
  if (url.protocol !== 'https:' || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) ||
    url.port || url.username || url.password || url.hash ||
    !/^\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\/[^?#]+$/.test(url.pathname) ||
    !url.searchParams.has('X-Amz-Signature')) {
    throw new Error('invalid_file_delivery');
  }
  const seconds = Number(url.searchParams.get('X-Amz-Expires'));
  const signedAt = url.searchParams.get('X-Amz-Date');
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400 ||
    !signedAt || !/^\d{8}T\d{6}Z$/.test(signedAt)) throw new Error('invalid_file_delivery');
  const expires = Date.parse(d.expires_at) - Date.now();
  if (!Number.isFinite(expires) || expires < 1000 || expires > seconds * 1000 + 60_000) throw new Error('invalid_file_delivery');
  return d as Ticket;
}

/** The stable entry/version URL is the cache key; signed URLs stay ephemeral. */
export async function fetchAttachment(src: string, options: Options = {}): Promise<Download> {
  const base = new URL(options.origin ?? location.href);
  const url = new URL(src, base);
  if (url.protocol !== base.protocol || url.host !== base.host || url.username || url.password ||
    !/^\/api\/entries\/[a-f0-9]{32}\/(?:file|image)$/.test(url.pathname)) {
    throw new Error('invalid_file_source');
  }
  url.searchParams.delete('delivery');
  const fetchImpl = options.fetchImpl ?? fetch;
  const legacy = options.fallback ? new URL(options.fallback, base) : undefined;
  if (legacy && (legacy.protocol !== base.protocol || legacy.host !== base.host ||
    !/^\/api\/entries\/[a-f0-9]{32}\/file$/.test(legacy.pathname))) throw new Error('invalid_file_source');
  const request = async (target: string) => {
    const response = await fetchImpl(target, {
      signal: options.signal, credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', referrerPolicy: 'no-referrer',
    });
    if (response.status === 401) options.onUnauthorized?.();
    if (!response.ok) throw new FileFetchError(response.status);
    return response;
  };
  const binary = async (response: Response): Promise<Download> => ({
    blob: await response.blob(),
    filename: /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] || 'file',
  });
  const native = options.native ?? ('__TAURI_INTERNALS__' in globalThis);
  const direct = new URL(url);
  if (!native) direct.searchParams.set('delivery', 'direct');
  let response: Response;
  try {
    response = await request(direct.href);
  } catch (error) {
    if (!legacy || options.signal?.aborted || error instanceof FileFetchError && error.status === 401) throw error;
    return binary(await request(legacy.href));
  }
  // Old/unconfigured APIs still return bytes. The marker distinguishes a
  // ticket from an actual uploaded JSON attachment.
  if (response.headers.get('X-TJUClaw-File-Delivery') !== 'r2') return binary(response);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 5000);
  try {
    const d = ticket(await response.json());
    const remote = await fetchImpl(d.url, {
      signal: controller.signal, credentials: 'omit', cache: 'no-store',
      redirect: 'error', referrerPolicy: 'no-referrer',
    });
    if (!remote.ok) throw new Error('file_delivery_unavailable');
    const blob = await remote.blob();
    const actualType = blob.type.split(';')[0].trim().toLowerCase();
    const expectedType = d.content_type.split(';')[0].trim().toLowerCase();
    // Forgejo LFS objects can have the generic binary media type in R2.
    // The authenticated repository path supplies the image type.
    if (blob.size !== d.size || actualType && actualType !== 'application/octet-stream' && actualType !== expectedType) {
      throw new Error('file_delivery_unavailable');
    }
    return { blob: new Blob([blob], { type: expectedType }), filename: d.filename };
  } catch {
    controller.abort();
    if (options.signal?.aborted) throw new DOMException('File request canceled', 'AbortError');
    // Includes expiry, CORS/CSP, network failures and invalid tickets. R2's
    // 401/403 belongs to this ticket and must not log the user out.
    try {
      return await binary(await request(url.href));
    } catch (error) {
      if (!legacy || options.signal?.aborted || error instanceof FileFetchError && error.status === 401) throw error;
      return binary(await request(legacy.href));
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
