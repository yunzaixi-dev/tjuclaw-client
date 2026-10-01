// pako ships no types; this covers the raw inflater the pack reader uses.
declare module 'pako' {
  export class Inflate {
    constructor(options?: { raw?: boolean });
    push(data: Uint8Array, flush?: boolean): boolean;
    result: Uint8Array | undefined;
    err: number;
    strm: { next_in: number };
  }
}
