// Git's pkt-line framing: four hex digits of length (including themselves),
// then the payload. 0000 is a flush, 0001 a delimiter, 0002 a response end.

export type Pkt = { kind: 'data'; payload: Uint8Array } | { kind: 'flush' | 'delim' | 'end' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const FLUSH = Symbol('flush');
export const DELIM = Symbol('delim');

/** Encodes text lines and the two separators into one request body. */
export function encodePkts(lines: (string | typeof FLUSH | typeof DELIM)[]): Uint8Array {
  const parts = lines.map(line => {
    if (line === FLUSH) return encoder.encode('0000');
    if (line === DELIM) return encoder.encode('0001');
    const payload = encoder.encode(line);
    if (payload.length > 65516) throw new Error('git_pkt_too_long');
    const out = new Uint8Array(payload.length + 4);
    out.set(encoder.encode((payload.length + 4).toString(16).padStart(4, '0')));
    out.set(payload, 4);
    return out;
  });
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return body;
}

export function* decodePkts(data: Uint8Array): Generator<Pkt> {
  let offset = 0;
  while (offset < data.length) {
    if (offset + 4 > data.length) throw new Error('git_pkt_truncated');
    const header = decoder.decode(data.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error('git_pkt_invalid');
    const length = parseInt(header, 16);
    if (length === 0) { offset += 4; yield { kind: 'flush' }; continue; }
    if (length === 1) { offset += 4; yield { kind: 'delim' }; continue; }
    if (length === 2) { offset += 4; yield { kind: 'end' }; continue; }
    if (length < 4 || offset + length > data.length) throw new Error('git_pkt_truncated');
    yield { kind: 'data', payload: data.subarray(offset + 4, offset + length) };
    offset += length;
  }
}

/** A text payload without its trailing newline. */
export const pktText = (payload: Uint8Array) => decoder.decode(payload).replace(/\n$/, '');
