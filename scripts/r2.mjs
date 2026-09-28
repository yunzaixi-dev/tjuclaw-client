import { createHash, createHmac } from 'node:crypto';

// Minimal S3 SigV4 client for Cloudflare R2: PUT, server-side COPY, HEAD and GET
// of single objects in one bucket. Path-style URLs, region "auto".

export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const VALID_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function validateObjectKey(key) {
  if (typeof key !== 'string' || !VALID_KEY_REGEX.test(key) || key.includes('..') || key.includes('//')) {
    throw new Error(`Invalid R2 object key "${key}"`);
  }
  return key;
}

export function readR2Config(env = process.env) {
  const config = {
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    publicUrl: env.R2_PUBLIC_URL,
  };
  const missing = Object.entries(config).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing R2 configuration: ${missing.join(', ')}`);
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.r2.cloudflarestorage.com') || endpoint.pathname !== '/') {
    throw new Error('R2_ENDPOINT must be the https://<account>.r2.cloudflarestorage.com endpoint');
  }
  const publicUrl = new URL(config.publicUrl);
  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/') {
    throw new Error('R2_PUBLIC_URL must be an https origin');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error('Invalid R2_BUCKET');
  return { ...config, endpoint: endpoint.origin, publicUrl: publicUrl.origin };
}

export function publicObjectUrl(r2, key) {
  return `${r2.publicUrl}/${validateObjectKey(key).split('/').map(encodeRfc3986).join('/')}`;
}

/**
 * Builds a signed request. `headers` are sent verbatim and all of them are signed.
 */
export function signR2Request(r2, { method, key, headers = {}, payloadHash = EMPTY_SHA256, now = new Date() }) {
  validateObjectKey(key);
  const url = new URL(r2.endpoint);
  const path = `/${r2.bucket}/${key.split('/').map(encodeRfc3986).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/auto/s3/aws4_request`;

  const all = { ...headers, host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map(n => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${r2.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const sent = { ...lower };
  delete sent.host;
  sent.authorization = `AWS4-HMAC-SHA256 Credential=${r2.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `${url.origin}${path}`, headers: sent };
}

async function send(r2, fetchFn, { method, key, headers, body, timeoutMs = 30000 }) {
  const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
  const req = signR2Request(r2, { method, key, headers, payloadHash });
  return fetchFn(req.url, { method, headers: req.headers, body, redirect: 'error' }, timeoutMs);
}

export async function r2Put(r2, key, body, { contentType, cacheControl, contentDisposition }, fetchFn) {
  const headers = { 'content-type': contentType, 'cache-control': cacheControl };
  if (contentDisposition) headers['content-disposition'] = contentDisposition;
  const res = await send(r2, fetchFn, { method: 'PUT', key, headers, body, timeoutMs: 300000 });
  if (!res.ok) throw new Error(`R2 upload of "${key}" failed (HTTP ${res.status})`);
}

export async function r2Copy(r2, sourceKey, key, { contentType, cacheControl, contentDisposition }, fetchFn) {
  validateObjectKey(sourceKey);
  const headers = {
    'x-amz-copy-source': `/${r2.bucket}/${sourceKey.split('/').map(encodeRfc3986).join('/')}`,
    'x-amz-metadata-directive': 'REPLACE',
    'content-type': contentType,
    'cache-control': cacheControl,
  };
  if (contentDisposition) headers['content-disposition'] = contentDisposition;
  const res = await send(r2, fetchFn, { method: 'PUT', key, headers, timeoutMs: 120000 });
  if (!res.ok) throw new Error(`R2 copy "${sourceKey}" -> "${key}" failed (HTTP ${res.status})`);
}

export async function r2Exists(r2, key, fetchFn) {
  const res = await send(r2, fetchFn, { method: 'HEAD', key });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`R2 lookup of "${key}" failed (HTTP ${res.status})`);
}

export async function r2GetText(r2, key, fetchFn) {
  const res = await send(r2, fetchFn, { method: 'GET', key });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 read of "${key}" failed (HTTP ${res.status})`);
  return res.text();
}

export async function r2Delete(r2, key, fetchFn) {
  const res = await send(r2, fetchFn, { method: 'DELETE', key });
  if (!res.ok && res.status !== 404) throw new Error(`R2 delete of "${key}" failed (HTTP ${res.status})`);
}
