// Reads a Git packfile (version 2) into whole objects: inflates every entry,
// resolves offset and reference deltas, and names each object by its SHA-1.
import { Inflate } from 'pako';

export type GitType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { oid: string; type: GitType; data: Uint8Array }
/** Looks up an object this pack deltas against but does not contain. */
export type BaseLookup = (oid: string) => Promise<{ type: GitType; data: Uint8Array } | null>;

const TYPES: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;
const encoder = new TextEncoder();

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

async function sha1(...parts: Uint8Array[]): Promise<string> {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-1', joined)));
}

/** The name Git gives an object: SHA-1 over "type size\0" and its content. */
export const objectId = (type: GitType, data: Uint8Array) => sha1(encoder.encode(`${type} ${data.length}\0`), data);

/** Inflates one zlib stream at the start of `input`; returns it and its compressed length. */
function inflate(input: Uint8Array, size: number): { data: Uint8Array; length: number } {
  // Raw mode stops at the end of the stream and reports the input it used;
  // the zlib mode would treat the next entry as a second member. The 2-byte
  // header and 4-byte Adler-32 are skipped: the pack's own SHA-1 covers them.
  if (input.length < 6 || (input[0]! & 0x0f) !== 8) throw new Error('git_pack_corrupt');
  const inflater = new Inflate({ raw: true });
  inflater.push(input.subarray(2), true);
  const data = inflater.result ?? new Uint8Array(0);
  if (inflater.err !== 0 || data.length !== size) throw new Error('git_pack_corrupt');
  return { data, length: 2 + inflater.strm.next_in + 4 };
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let offset = 0;
  const varint = () => {
    let value = 0, shift = 0, byte = 0;
    do {
      if (offset >= delta.length) throw new Error('git_pack_corrupt');
      byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  if (varint() !== base.length) throw new Error('git_pack_corrupt');
  const out = new Uint8Array(varint());
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let from = 0, length = 0;
      for (let bit = 0; bit < 4; bit++) if (op & (1 << bit)) from += delta[offset++]! * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit++) if (op & (0x10 << bit)) length += delta[offset++]! * 2 ** (8 * bit);
      if (length === 0) length = 0x10000;
      if (from + length > base.length || written + length > out.length) throw new Error('git_pack_corrupt');
      out.set(base.subarray(from, from + length), written);
      written += length;
    } else if (op > 0) {
      if (offset + op > delta.length || written + op > out.length) throw new Error('git_pack_corrupt');
      out.set(delta.subarray(offset, offset + op), written);
      offset += op;
      written += op;
    } else {
      throw new Error('git_pack_corrupt');
    }
  }
  if (written !== out.length) throw new Error('git_pack_corrupt');
  return out;
}

type Entry = { type: GitType; data: Uint8Array } | { delta: Uint8Array; baseOffset?: number; baseOid?: string };

export async function parsePack(pack: Uint8Array, lookup: BaseLookup = async () => null): Promise<GitObject[]> {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (pack.length < 32 || view.getUint32(0) !== 0x5041434b || view.getUint32(4) !== 2) throw new Error('git_pack_invalid');
  if (await sha1(pack.subarray(0, pack.length - 20)) !== hex(pack.subarray(pack.length - 20))) throw new Error('git_pack_corrupt');
  const count = view.getUint32(8);
  const end = pack.length - 20;
  const entries = new Map<number, Entry>();
  let offset = 12;
  for (let index = 0; index < count; index++) {
    const start = offset;
    if (offset >= end) throw new Error('git_pack_corrupt');
    let byte = pack[offset++]!;
    const kind = (byte >> 4) & 7;
    let size = byte & 0x0f, shift = 4;
    while (byte & 0x80) {
      if (offset >= end) throw new Error('git_pack_corrupt');
      byte = pack[offset++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined, baseOid: string | undefined;
    if (kind === OFS_DELTA) {
      byte = pack[offset++]!;
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= end) throw new Error('git_pack_corrupt');
        byte = pack[offset++]!;
        distance = (distance + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = start - distance;
      if (baseOffset < 12) throw new Error('git_pack_corrupt');
    } else if (kind === REF_DELTA) {
      if (offset + 20 > end) throw new Error('git_pack_corrupt');
      baseOid = hex(pack.subarray(offset, offset + 20));
      offset += 20;
    } else if (!TYPES[kind]) {
      throw new Error('git_pack_corrupt');
    }
    const body = inflate(pack.subarray(offset, end), size);
    offset += body.length;
    entries.set(start, TYPES[kind] ? { type: TYPES[kind], data: body.data } : { delta: body.data, baseOffset, baseOid });
  }
  if (offset !== end) throw new Error('git_pack_corrupt');

  // A delta's base can itself be a delta, and a reference base may come later
  // in the pack, so resolve until nothing is left or nothing moves.
  const objects: GitObject[] = [];
  const byOid = new Map<string, { type: GitType; data: Uint8Array }>();
  const done = new Map<number, { type: GitType; data: Uint8Array }>();
  const finish = async (at: number, type: GitType, data: Uint8Array) => {
    const object = { oid: await objectId(type, data), type, data };
    done.set(at, object);
    byOid.set(object.oid, object);
    objects.push(object);
  };
  let waiting = [...entries.entries()];
  while (waiting.length) {
    const next: typeof waiting = [];
    for (const [at, entry] of waiting) {
      if ('type' in entry) { await finish(at, entry.type, entry.data); continue; }
      const base = entry.baseOffset !== undefined ? done.get(entry.baseOffset)
        : byOid.get(entry.baseOid!) ?? await lookup(entry.baseOid!);
      if (base) await finish(at, base.type, applyDelta(base.data, entry.delta));
      else next.push([at, entry]);
    }
    if (next.length === waiting.length) throw new Error('git_pack_missing_base');
    waiting = next;
  }
  return objects;
}
