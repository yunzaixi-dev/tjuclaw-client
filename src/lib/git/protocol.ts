// A fetch-only client for Git's smart HTTP protocol, version 2: list the
// remote's refs and download the pack that brings the local objects up to date.
import { decodePkts, DELIM, encodePkts, FLUSH, pktText } from './pkt.ts';

/** POSTs one upload-pack request and returns the response body. */
export type GitTransport = (body: Uint8Array) => Promise<Uint8Array>;

const OID = /^[0-9a-f]{40}$/;
const decoder = new TextDecoder();

/** A transport for a repository URL (…/name.git) reachable with fetch. */
export function httpTransport(repository: string, init: RequestInit = {}): GitTransport {
  return async body => {
    const response = await fetch(`${repository.replace(/\/$/, '')}/git-upload-pack`, {
      ...init,
      method: 'POST',
      headers: {
        ...init.headers,
        'Content-Type': 'application/x-git-upload-pack-request',
        Accept: 'application/x-git-upload-pack-result',
        'Git-Protocol': 'version=2',
      },
      body: body as BodyInit,
    });
    if (!response.ok) throw new Error(`git_http_${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

/** The remote's refs under the given prefixes, name → commit. */
export async function listRefs(transport: GitTransport, prefixes: string[] = ['refs/heads/']): Promise<Map<string, string>> {
  const response = await transport(encodePkts([
    'command=ls-refs\n', 'object-format=sha1\n', DELIM,
    ...prefixes.map(prefix => `ref-prefix ${prefix}\n`), FLUSH,
  ]));
  const refs = new Map<string, string>();
  for (const pkt of decodePkts(response)) {
    if (pkt.kind !== 'data') continue;
    const [oid, name] = pktText(pkt.payload).split(' ');
    if (!oid || !name || !OID.test(oid)) throw new Error('git_refs_invalid');
    refs.set(name, oid);
  }
  return refs;
}

/** The pack holding `wants` and their history, minus what `haves` already cover. */
export async function fetchPack(transport: GitTransport, wants: string[], haves: string[] = []): Promise<Uint8Array> {
  if (!wants.length || ![...wants, ...haves].every(oid => OID.test(oid))) throw new Error('git_fetch_invalid');
  const response = await transport(encodePkts([
    'command=fetch\n', 'object-format=sha1\n', DELIM,
    'no-progress\n', 'ofs-delta\n',
    ...wants.map(oid => `want ${oid}\n`), ...haves.map(oid => `have ${oid}\n`),
    'done\n', FLUSH,
  ]));
  const chunks: Uint8Array[] = [];
  let inPack = false;
  for (const pkt of decodePkts(response)) {
    if (pkt.kind !== 'data') { inPack = false; continue; }
    if (!inPack) {
      if (pktText(pkt.payload) === 'packfile') inPack = true;
      continue;
    }
    // Side band: 1 carries pack data, 2 progress text, 3 a fatal error.
    const band = pkt.payload[0];
    if (band === 1) chunks.push(pkt.payload.subarray(1));
    else if (band === 3) throw new Error(`git_fetch_failed: ${decoder.decode(pkt.payload.subarray(1)).trim().slice(0, 200)}`);
  }
  const pack = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { pack.set(chunk, offset); offset += chunk.length; }
  if (!pack.length) throw new Error('git_fetch_empty');
  return pack;
}
